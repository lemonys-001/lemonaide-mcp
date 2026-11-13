/**
 * HTTP API surface served under /api/*:
 *
 *  - /api/internal/*  build-runner callbacks (BUILD_RUNNER_TOKEN bearer)
 *  - everything else   dashboard + MCP-adjacent REST, authenticated with a
 *                      Supabase JWT (Bearer) or the dev-only x-dev-user header
 */

import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ErrorCode, LemonAIdeError, httpStatusForErrorCode } from "@lemonaide/shared";
import type { Env } from "../env";
import { isProduction } from "../env";
import { JwtVerificationError, verifySupabaseJwt } from "../auth/jwts";
import { getSupabaseServiceClient } from "../db/supabase";
import { ensureProfile, getProfile, recordAudit } from "../db/profiles";
import * as repos from "../db/repos";
import { jsonErr, jsonOk, newCorrelationId } from "../lib/http";
import { supabasePasswordGrant } from "../auth/supabase-upstream";
import {
  createProject,
  deleteProjectFully,
  liveUrlFor,
  renameProject,
  setProjectArchived,
  validateProject,
  type Actor,
} from "../services/projects";
import {
  appendBuildLogs,
  buildSourceBundle,
  completeBuild,
  readBuildLogs,
  reportBuildRunning,
  startBuild,
  storeArtifactBatch,
  verifyRunnerToken,
} from "../services/builds";
import { deployProject, describeDeployment, liveUrlForDeployment, rollbackDeployment, unpublishProject } from "../services/deploys";
import { deleteAccount } from "../services/accounts";
import {
  buildAppManifest,
  connectInstallation,
  connectUrl,
  createRepoForProject,
  disconnectRepo,
  exchangeManifestCode,
  getGithubAppConfig,
  hasGithubApp,
  getInstallationLogin,
  readConnectState,
  refreshAppSetupUrl,
  saveGithubAppConfig,
  signConnectState,
  syncProjectToGitHub,
} from "../services/github";
import { deleteSourceFile, getSourceFile, listSourceFiles, putSourceFile } from "../storage/source";

interface ApiUser {
  userId: string;
  username: string;
  via: "dashboard";
}

type Vars = { user: ApiUser };

function actorOf(user: ApiUser): Actor {
  return { userId: user.userId, username: user.username, via: "dashboard" };
}

async function requireProjectFor(env: Env, user: ApiUser, ref: string) {
  const db = getSupabaseServiceClient(env);
  const project = await resolveOwnedProject(db, user.userId, ref);
  if (!project) throw new LemonAIdeError(ErrorCode.NOT_FOUND, `no project "${ref}"`);
  return { db, project };
}

// PostgREST 22P02s when a non-uuid hits the id column, so only try id when
// the ref is uuid-shaped (same guard as the MCP layer).
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
async function resolveOwnedProject(db: SupabaseClient, userId: string, ref: string) {
  if (UUID_RE.test(ref)) {
    return (await repos.getProject(db, userId, ref)) ?? (await repos.getProjectBySlug(db, userId, ref));
  }
  return repos.getProjectBySlug(db, userId, ref);
}

export function createApiRouter(env: Env): Hono<{ Variables: Vars }> {
  const app = new Hono<{ Variables: Vars }>().basePath("/api");

  /* ---------------------------------------------------------------- */
  /* Build-runner internal endpoints                                   */
  /* ---------------------------------------------------------------- */

  const runnerAuth: MiddlewareHandler<{ Variables: Vars }> = async (c, next) => {
    const presented = c.req.header("authorization")?.replace(/^Bearer\s+/i, "") ?? null;
    if (!verifyRunnerToken(env, presented)) {
      return jsonErr(ErrorCode.UNAUTHENTICATED, "invalid runner token", newCorrelationId(), 401);
    }
    await next();
  };

  app.post("/internal/builds/:id/start", runnerAuth, async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { runner_run_id?: number };
    await reportBuildRunning(getSupabaseServiceClient(env), c.req.param("id"), body.runner_run_id);
    return jsonOk({ ok: true }, newCorrelationId());
  });

  app.get("/internal/builds/:id/source", runnerAuth, async (c) => {
    const bundle = await buildSourceBundle(env, getSupabaseServiceClient(env), c.req.param("id"));
    return jsonOk(bundle, newCorrelationId());
  });

  app.post("/internal/builds/:id/logs", runnerAuth, async (c) => {
    const body = (await c.req.json()) as { content: string };
    await appendBuildLogs(env, getSupabaseServiceClient(env), c.req.param("id"), String(body.content ?? ""));
    return jsonOk({ ok: true }, newCorrelationId());
  });

  app.post("/internal/builds/:id/artifacts", runnerAuth, async (c) => {
    const body = (await c.req.json()) as { files: { path: string; content: string; encoding?: "base64" | "utf8" }[] };
    const result = await storeArtifactBatch(env, getSupabaseServiceClient(env), c.req.param("id"), { files: body.files ?? [] });
    return jsonOk(result, newCorrelationId());
  });

  app.post("/internal/builds/:id/complete", runnerAuth, async (c) => {
    const body = (await c.req.json()) as {
      status: "succeeded" | "failed" | "canceled";
      error_code?: string;
      error_message?: string;
      runner_run_id?: number;
    };
    await completeBuild(env, getSupabaseServiceClient(env), c.req.param("id"), {
      status: body.status,
      errorCode: body.error_code,
      errorMessage: body.error_message,
      runnerRunId: body.runner_run_id,
    });
    return jsonOk({ ok: true }, newCorrelationId());
  });

  /* ---------------------------------------------------------------- */
  /* Public endpoints (no auth)                                        */
  /* ---------------------------------------------------------------- */

  const USERNAME_RE = /^[a-z0-9](?:[a-z0-9-]{1,28}[a-z0-9])?$/;
  const RESERVED_USERNAMES = new Set([
    "api", "mcp", "oauth", "auth", "assets", "static", "app", "apps",
    "dashboard", "admin", "health", "login", "logout", "callback", "authorize",
    "register", "token", "www", "mail", "support", "help", "docs", "blog",
    "settings", "account", "projects", "lemonaide", "lemonai", "null",
    "undefined", "internal", "worker", "build", "builds", "deploy", "deploys",
  ]);

  app.get("/username-available", async (c) => {
    const username = (c.req.query("username") ?? "").trim().toLowerCase();
    if (!USERNAME_RE.test(username)) {
      return jsonOk({ username, available: false, reason: "invalid" as const }, newCorrelationId());
    }
    if (RESERVED_USERNAMES.has(username)) {
      return jsonOk({ username, available: false, reason: "reserved" as const }, newCorrelationId());
    }
    const db = getSupabaseServiceClient(env);
    const { data, error } = await db.from("profiles").select("id").ilike("username", username).limit(1);
    if (error) throw new LemonAIdeError(ErrorCode.INTERNAL, error.message);
    const taken = (data ?? []).length > 0;
    return jsonOk(
      { username, available: !taken, reason: taken ? ("taken" as const) : undefined },
      newCorrelationId(),
    );
  });

  /* ---------------------------------------------------------------- */
  /* Dashboard API (user auth)                                         */
  /* ---------------------------------------------------------------- */

  app.use(async (c, next) => {
    // Public, self-authenticating endpoints:
    //  - GitHub redirect callback: HMAC'd state parameter (browser redirect, no Bearer)
    //  - GitHub webhook: X-Hub-Signature-256 HMAC over the raw body
    if (
      (c.req.method === "GET" && c.req.path === "/api/github/callback") ||
      (c.req.method === "GET" && c.req.path === "/api/github/app-manifest") ||
      (c.req.method === "GET" && c.req.path === "/api/github/manifest-setup") ||
      (c.req.method === "POST" && c.req.path === "/api/github/webhook") ||
      (c.req.method === "POST" && c.req.path === "/api/auth/session-bootstrap")
    ) {
      await next();
      return;
    }
    try {
      const user = await authenticate(env, c.req.header("authorization"), c.req.header("x-dev-user"));
      c.set("user", user);
      await next();
    } catch (err) {
      const status = err instanceof JwtVerificationError ? 401 : err instanceof LemonAIdeError ? httpStatusForErrorCode(err.code) : 500;
      const code = err instanceof JwtVerificationError ? ErrorCode.UNAUTHENTICATED : err instanceof LemonAIdeError ? err.code : ErrorCode.INTERNAL;
      return jsonErr(code, err instanceof Error ? err.message : String(err), newCorrelationId(), status);
    }
  });

  /* Public: exchange email+password for a browser-storable Supabase session.
     Used by the MCP consent page so the dashboard recognizes the same login.
     Same trust level as supabase-js calling the GoTrue endpoint directly. */
  app.post("/auth/session-bootstrap", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { email?: string; password?: string };
    const email = String(body.email ?? "").trim();
    const password = String(body.password ?? "");
    if (!email || !password) {
      return jsonErr(ErrorCode.INVALID_INPUT, "email and password are required", newCorrelationId(), 400);
    }
    try {
      const session = await supabasePasswordGrant(env, email, password);
      return jsonOk(
        {
          access_token: session.access_token,
          refresh_token: session.refresh_token ?? null,
          expires_in: (session as { expires_in?: number }).expires_in ?? 3600,
          user: session.user,
        },
        newCorrelationId(),
      );
    } catch (err) {
      return jsonErr(
        ErrorCode.UNAUTHENTICATED,
        err instanceof Error ? err.message : "invalid email or password",
        newCorrelationId(),
        401,
      );
    }
  });

  app.get("/me", async (c) => {
    const user = c.get("user");
    const db = getSupabaseServiceClient(env);
    const profile = await getProfile(db, user.userId);
    const grants = await repos.listMcpAuthorizations(db, user.userId);
    return jsonOk(
      {
        userId: user.userId,
        username: profile?.username ?? user.username,
        displayName: profile?.display_name ?? null,
        avatarUrl: profile?.avatar_url ?? null,
        mcpConnections: grants.length,
        liveUrlPattern: `https://<domain>/{username}/{project}`,
      },
      newCorrelationId(),
    );
  });

  app.delete("/me", async (c) => {
    const user = c.get("user");
    await deleteAccount(env, user.userId);
    return jsonOk({ deleted: true }, newCorrelationId());
  });

  /* Projects */

  app.get("/projects", async (c) => {
    const user = c.get("user");
    const db = getSupabaseServiceClient(env);
    const status = (c.req.query("status") as "active" | "archived" | "all" | undefined) ?? "active";
    const projects = await repos.listProjects(db, user.userId, { status });
    const currentByProject = await repos.listCurrentDeployments(
      db,
      projects.map((p) => p.id),
    );
    return jsonOk(
      projects.map((p) => ({
        ...p,
        liveUrl: liveUrlFor(env, user.username, p.slug),
        currentDeployment: currentByProject.has(p.id) ? describeDeployment(currentByProject.get(p.id)!) : null,
      })),
      newCorrelationId(),
    );
  });

  app.post("/projects", async (c) => {
    const user = c.get("user");
    const db = getSupabaseServiceClient(env);
    const body = await c.req.json();
    const project = await createProject(env, db, actorOf(user), {
      name: String(body.name ?? ""),
      description: body.description ? String(body.description) : undefined,
      framework: body.framework,
      slug: body.slug ? String(body.slug) : undefined,
    });
    return jsonOk({ ...project, liveUrl: liveUrlFor(env, user.username, project.slug) }, newCorrelationId(), 201);
  });

  app.get("/projects/:ref", async (c) => {
    const user = c.get("user");
    const { db, project } = await requireProjectFor(env, user, c.req.param("ref"));
    const current = await repos.getCurrentDeploymentByProject(db, project.id);
    return jsonOk(
      {
        ...project,
        liveUrl: liveUrlFor(env, user.username, project.slug),
        currentDeployment: current ? describeDeployment(current) : null,
      },
      newCorrelationId(),
    );
  });

  app.patch("/projects/:ref", async (c) => {
    const user = c.get("user");
    const { db, project } = await requireProjectFor(env, user, c.req.param("ref"));
    const body = await c.req.json();
    let updated = project;
    if (body.name && String(body.name) !== project.name) {
      updated = await renameProject(env, db, actorOf(user), project, String(body.name), Boolean(body.update_slug));
    }
    if (body.description !== undefined) {
      updated = await repos.updateProject(db, user.userId, project.id, {
        description: body.description === null ? null : String(body.description),
      });
    }
    if (body.status === "archived" || body.status === "active") {
      updated = await setProjectArchived(db, actorOf(user), project, body.status === "archived");
    }
    return jsonOk({ ...updated, liveUrl: liveUrlFor(env, user.username, updated.slug) }, newCorrelationId());
  });

  app.delete("/projects/:ref", async (c) => {
    const user = c.get("user");
    const { db, project } = await requireProjectFor(env, user, c.req.param("ref"));
    const confirm = c.req.query("confirm_slug") ?? "";
    await deleteProjectFully(env, db, actorOf(user), project, String(confirm));
    return jsonOk({ deleted: true, project: project.slug }, newCorrelationId());
  });

  /* Files */

  app.get("/projects/:ref/files", async (c) => {
    const user = c.get("user");
    const { project } = await requireProjectFor(env, user, c.req.param("ref"));
    const directory = c.req.query("directory") || undefined;
    const files = await listSourceFiles(env.BLOB_STORE, project.id, directory);
    return jsonOk(files, newCorrelationId());
  });

  app.get("/projects/:ref/files/*", async (c) => {
    const user = c.get("user");
    const { project } = await requireProjectFor(env, user, c.req.param("ref"));
    const path = decodeURIComponent(c.req.param("*") ?? "");
    const content = await getSourceFile(env.BLOB_STORE, project.id, path);
    if (content === null) return jsonErr(ErrorCode.NOT_FOUND, "file not found", newCorrelationId(), 404);
    return jsonOk({ path, content }, newCorrelationId());
  });

  app.put("/projects/:ref/files/*", async (c) => {
    const user = c.get("user");
    const { db, project } = await requireProjectFor(env, user, c.req.param("ref"));
    const path = decodeURIComponent(c.req.param("*") ?? "");
    const body = (await c.req.json()) as { content: string };
    const { size, sha256 } = await putSourceFile(env.BLOB_STORE, project.id, path, String(body.content ?? ""));
    await repos.upsertFileRows(db, project.id, [{ path, size, sha256 }]);
    return jsonOk({ path, size, sha256 }, newCorrelationId());
  });

  app.delete("/projects/:ref/files/*", async (c) => {
    const user = c.get("user");
    const { db, project } = await requireProjectFor(env, user, c.req.param("ref"));
    const path = decodeURIComponent(c.req.param("*") ?? "");
    const removed = await repos.deleteFileRow(db, project.id, path);
    if (!removed) return jsonErr(ErrorCode.NOT_FOUND, "file not found", newCorrelationId(), 404);
    await deleteSourceFile(env.BLOB_STORE, project.id, path);
    return jsonOk({ path, deleted: true }, newCorrelationId());
  });

  app.post("/projects/:ref/validate", async (c) => {
    const user = c.get("user");
    const { project } = await requireProjectFor(env, user, c.req.param("ref"));
    const issues = await validateProject(env, project);
    return jsonOk({ valid: !issues.some((i) => i.severity === "error"), issues }, newCorrelationId());
  });

  /* Builds */

  app.post("/projects/:ref/builds", async (c) => {
    const user = c.get("user");
    const { db, project } = await requireProjectFor(env, user, c.req.param("ref"));
    const body = (await c.req.json().catch(() => ({}))) as { install_dependencies?: boolean; idempotency_key?: string };
    const { build, reused } = await startBuild(env, db, actorOf(user), project, {
      installDependencies: body.install_dependencies,
      idempotencyKey: body.idempotency_key,
    });
    return jsonOk({ ...build, reused }, newCorrelationId(), 201);
  });

  app.get("/projects/:ref/builds", async (c) => {
    const user = c.get("user");
    const { db, project } = await requireProjectFor(env, user, c.req.param("ref"));
    const limit = Number(c.req.query("limit") ?? 20);
    return jsonOk(await repos.listBuilds(db, user.userId, project.id, limit), newCorrelationId());
  });

  app.get("/builds/:id", async (c) => {
    const user = c.get("user");
    const db = getSupabaseServiceClient(env);
    const build = await repos.getBuildForOwner(db, user.userId, c.req.param("id"));
    if (!build) return jsonErr(ErrorCode.NOT_FOUND, "build not found", newCorrelationId(), 404);
    return jsonOk(build, newCorrelationId());
  });

  app.get("/builds/:id/logs", async (c) => {
    const user = c.get("user");
    const db = getSupabaseServiceClient(env);
    const build = await repos.getBuildForOwner(db, user.userId, c.req.param("id"));
    if (!build) return jsonErr(ErrorCode.NOT_FOUND, "build not found", newCorrelationId(), 404);
    const logs = await readBuildLogs(env, c.req.param("id"), Number(c.req.query("offset") ?? 0), Number(c.req.query("limit") ?? 16_000));
    return jsonOk({ ...logs, status: build.status, logTruncated: build.log_truncated }, newCorrelationId());
  });

  /* Deployments */

  app.post("/projects/:ref/deployments", async (c) => {
    const user = c.get("user");
    const { db, project } = await requireProjectFor(env, user, c.req.param("ref"));
    const body = (await c.req.json().catch(() => ({}))) as { build_id?: string };
    const result = await deployProject(env, db, actorOf(user), project, { buildId: body.build_id });
    return jsonOk({ ...describeDeployment(result.deployment), liveUrl: result.liveUrl }, newCorrelationId(), 201);
  });

  app.get("/projects/:ref/deployments", async (c) => {
    const user = c.get("user");
    const { db, project } = await requireProjectFor(env, user, c.req.param("ref"));
    const limit = Number(c.req.query("limit") ?? 20);
    const deployments = await repos.listDeploymentsForOwner(db, user.userId, project.id, limit);
    return jsonOk(deployments.map((d) => ({ ...describeDeployment(d), liveUrl: liveUrlForDeployment(env, d) })), newCorrelationId());
  });

  app.post("/projects/:ref/deployments/:id/rollback", async (c) => {
    const user = c.get("user");
    const { db, project } = await requireProjectFor(env, user, c.req.param("ref"));
    const result = await rollbackDeployment(env, db, actorOf(user), project, c.req.param("id"));
    return jsonOk({ ...describeDeployment(result.deployment), liveUrl: result.liveUrl }, newCorrelationId());
  });

  app.delete("/projects/:ref/deployments", async (c) => {
    const user = c.get("user");
    const { db, project } = await requireProjectFor(env, user, c.req.param("ref"));
    await unpublishProject(db, actorOf(user), project);
    return jsonOk({ unpublished: true }, newCorrelationId());
  });

  /* GitHub */

  app.get("/github/status", async (c) => {
    const user = c.get("user");
    const db = getSupabaseServiceClient(env);
    const installation = await repos.getGithubInstallation(db, user.userId);

    if (installation) {
      return jsonOk(
        { mode: "app", connected: true, account: installation.account_login, connectUrl: null },
        newCorrelationId(),
      );
    }

    const appMode = await hasGithubApp(env);
    let url: string | null = null;
    if (appMode) {
      try {
        url = await connectUrl(env);
      } catch {
        url = null;
      }
    }
    // App not registered yet: the owner mints a signed setup link from
    // GET /github/setup-url (the manifest page has no Bearer auth).
    return jsonOk(
      { mode: appMode ? "app" : "none", connected: false, account: null, connectUrl: url },
      newCorrelationId(),
    );
  });

  // One-time owner setup: serves a page that POSTs the app manifest to GitHub.
  // GitHub then redirects back to /github/manifest-setup with a code we trade
  // for the app's credentials (stored in KV — no redeploy needed).
  // Serves a page that POSTs the app manifest to GitHub. Public but bound to a
  // signed state (same HMAC as the connect flow) so only a signed-in owner's
  // dashboard can mint the link.
  app.get("/github/app-manifest", async (c) => {
    const state = c.req.query("state") ?? "";
    const userId = await readConnectState(env, state);
    if (!userId) {
      return c.html(
        `<!doctype html><html><body style="font-family:system-ui;background:#0f120b;color:#e07a5f;display:grid;place-items:center;min-height:100vh">` +
          `<p>Invalid setup link — start again from the dashboard.</p></body></html>`,
        401,
      );
    }
    if (await hasGithubApp(env)) {
      return c.redirect(`${primaryBase(env)}/#/settings`, 302);
    }
    // Long TTL: GitHub holds this state inside the app's setup_url indefinitely.
    const setupState = await signConnectState(env, userId, 90 * 24 * 60 * 60_000);
    const manifest = JSON.stringify(buildAppManifest(env, setupState));
    const action = `https://github.com/settings/apps/new?state=${encodeURIComponent(setupState)}`;
    return c.html(
      `<!doctype html><html><body style="font-family:system-ui;background:#0f120b;color:#edebdd;display:grid;place-items:center;min-height:100vh">` +
        `<p>Redirecting to GitHub to register the LemonAIde app…</p>` +
        `<form id="f" action="${action}" method="post"><input type="hidden" name="manifest" value='${manifest.replace(/'/g, "&#39;")}'></form>` +
        `<script>document.getElementById("f").submit()</script>` +
        `</body></html>`,
    );
  });

  // Signed, browser-navigable setup link (the manifest page itself has no Bearer).
  app.get("/github/setup-url", async (c) => {
    if (await hasGithubApp(env)) {
      // Repair: GitHub holds the app's setup_url with an expiring state —
      // repoint it at a fresh signed state so the next install callback works.
      await refreshAppSetupUrl(env, c.get("user").userId);
      return jsonOk({ url: null, configured: true }, newCorrelationId());
    }
    const user = c.get("user");
    const state = await signConnectState(env, user.userId, 60 * 60_000);
    return jsonOk({ url: `${primaryBase(env)}/api/github/app-manifest?state=${encodeURIComponent(state)}`, configured: false }, newCorrelationId());
  });

  app.get("/github/manifest-setup", async (c) => {
    const code = c.req.query("code") ?? "";
    const state = c.req.query("state") ?? "";
    const userId = await readConnectState(env, state);
    if (!code || !userId) {
      return c.html(
        `<!doctype html><html><body style="font-family:system-ui;background:#0f120b;color:#e07a5f;display:grid;place-items:center;min-height:100vh">` +
          `<p>Invalid setup link — start again from the dashboard settings page.</p></body></html>`,
      );
    }
    try {
      const conv = await exchangeManifestCode(code);
      await saveGithubAppConfig(env, {
        appId: String(conv.id),
        slug: conv.slug,
        clientId: conv.client_id,
        clientSecret: conv.client_secret,
        privateKeyPem: conv.pem,
        webhookSecret: conv.webhook_secret,
      });
      const db = getSupabaseServiceClient(env);
      await recordAudit(db, {
        userId,
        actorType: "dashboard",
        action: "github.app_created",
        targetType: "github_app",
        targetId: String(conv.id),
        meta: { slug: conv.slug },
      });
      // Send the owner straight to install the app on their account.
      return c.redirect(`https://github.com/apps/${encodeURIComponent(conv.slug)}/installations/new`, 302);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "unknown error";
      return c.html(
        `<!doctype html><html><body style="font-family:system-ui;background:#0f120b;color:#e07a5f;display:grid;place-items:center;min-height:100vh">` +
          `<p>GitHub app setup failed: ${msg}</p><p><a href="${primaryBase(env)}/#/settings" style="color:#e9c842">Back to settings</a></p></body></html>`,
      );
    }
  });



  app.post("/github/webhook", async (c) => {
    const appCfg = await getGithubAppConfig(env);
    const secret = appCfg?.webhookSecret;
    if (!secret) {
      return jsonErr(ErrorCode.NOT_CONFIGURED, "webhook secret not configured", newCorrelationId(), 500);
    }
    const body = await c.req.text();
    const signature = c.req.header("x-hub-signature-256") ?? "";
    if (!(await verifyGithubSignature(secret, body, signature))) {
      return jsonErr(ErrorCode.UNAUTHENTICATED, "bad webhook signature", newCorrelationId(), 401);
    }

    const event = c.req.header("x-github-event") ?? "";
    if (event === "installation") {
      const payload = JSON.parse(body || "{}") as {
        action?: string;
        installation?: { id?: number };
      };
      const installationId = payload.installation?.id ?? 0;
      if (installationId) {
        const db = getSupabaseServiceClient(env);
        if (payload.action === "deleted") {
          await repos.deleteGithubInstallation(db, installationId);
        } else if (payload.action === "suspend") {
          await repos.setGithubInstallationSuspended(db, installationId, true);
        } else if (payload.action === "unsuspend") {
          await repos.setGithubInstallationSuspended(db, installationId, false);
        }
      }
    }
    return jsonOk({ received: true }, newCorrelationId());
  });

  app.get("/github/callback", async (c) => {
    const installationId = Number(c.req.query("installation_id") ?? 0);
    const state = String(c.req.query("state") ?? "");
    const userId = await readConnectState(env, state);
    // App-settings updates land here with setup_action=update and no installation.
    if (!installationId && c.req.query("setup_action") === "update") {
      return c.redirect(`${primaryBase(env)}/#/settings`, 302);
    }
    if (!installationId || (!userId && !c.req.query("installation_id"))) {
      return c.html(
        `<!doctype html><html><body style="font-family:system-ui;background:#0f120b;color:#e07a5f;display:grid;place-items:center;min-height:100vh">` +
          `<p>Invalid GitHub connect callback — start again from the dashboard settings page.</p></body></html>`,
        400,
      );
    }
    const db = getSupabaseServiceClient(env);
    try {
      let profile: { id: string; username: string } | null = userId ? await getProfile(db, userId) : null;
      if (!profile && userId) {
        return c.html(
          `<!doctype html><html><body style="font-family:system-ui;background:#0f120b;color:#e07a5f;display:grid;place-items:center;min-height:100vh">` +
            `<p>Unknown user for connect state — start again from the dashboard settings page.</p></body></html>`,
          404,
        );
      }
      if (!profile) {
        // Expired/foreign state but a valid installation: attribute it by
        // matching the installation's GitHub login to a profile username.
        const login = await getInstallationLogin(env, installationId);
        const match = login
          ? await db.from("profiles").select("id, username").ilike("username", login).maybeSingle()
          : null;
        if (!match?.data) {
          return c.html(
            `<!doctype html><html><body style="font-family:system-ui;background:#0f120b;color:#e07a5f;display:grid;place-items:center;min-height:100vh">` +
              `<p>This setup link expired and the GitHub account <code>${(login ?? "unknown").replace(/[<>&"]/g, (ch) => `&#${ch.charCodeAt(0)};`)}</code> has no matching LemonAIde profile. Start again from the dashboard settings page.</p></body></html>`,
            400,
          );
        }
        profile = { id: String(match.data.id), username: String(match.data.username) };
      }
      await connectInstallation(env, db, { userId: profile.id, username: profile.username, via: "dashboard" }, installationId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(JSON.stringify({ level: "error", msg: "github connect callback failed", installationId, err: msg }));
      return c.html(
        `<!doctype html><html><body style="font-family:system-ui;background:#0f120b;color:#e07a5f;display:grid;place-items:center;min-height:100vh">` +
          `<p>Connecting GitHub failed: ${msg.replace(/[<>&"]/g, (ch) => `&#${ch.charCodeAt(0)};`)}</p>` +
          `<p><a href="${primaryBase(env)}/#/settings" style="color:#e9c842">Back to settings</a></p></body></html>`,
        500,
      );
    }
    const redirectTo = String(c.req.query("redirect_to") ?? `${primaryBase(env)}/#/settings`);
    return c.redirect(redirectTo, 302);
  });

  app.get("/projects/:ref/github", async (c) => {
    const user = c.get("user");
    const { db, project } = await requireProjectFor(env, user, c.req.param("ref"));
    const repo = await repos.getGithubRepository(db, project.id);
    return jsonOk(
      repo
        ? { repo: { fullName: repo.repo_full_name, url: repo.repo_url, defaultBranch: repo.default_branch, lastCommitSha: repo.last_commit_sha, lastSyncedAt: repo.last_synced_at } }
        : { repo: null },
      newCorrelationId(),
    );
  });

  app.post("/projects/:ref/github/repo", async (c) => {
    const user = c.get("user");
    const { db, project } = await requireProjectFor(env, user, c.req.param("ref"));
    const body = (await c.req.json().catch(() => ({}))) as { private?: boolean };
    const { repo } = await createRepoForProject(env, db, actorOf(user), project, { privateRepo: body.private ?? true });
    return jsonOk({ fullName: repo.repo_full_name, url: repo.repo_url, defaultBranch: repo.default_branch }, newCorrelationId(), 201);
  });

  app.post("/projects/:ref/github/sync", async (c) => {
    const user = c.get("user");
    const { db, project } = await requireProjectFor(env, user, c.req.param("ref"));
    return jsonOk(await syncProjectToGitHub(env, db, actorOf(user), project), newCorrelationId());
  });

  app.delete("/projects/:ref/github", async (c) => {
    const user = c.get("user");
    const { db, project } = await requireProjectFor(env, user, c.req.param("ref"));
    await disconnectRepo(db, actorOf(user), project);
    return jsonOk({ disconnected: true }, newCorrelationId());
  });

  /* MCP connection management */

  app.get("/authorizations", async (c) => {
    const user = c.get("user");
    const db = getSupabaseServiceClient(env);
    const grants = await repos.listMcpAuthorizations(db, user.userId);
    return jsonOk(
      grants.map((g) => ({
        grantId: g.grant_id,
        clientId: g.client_id,
        clientName: g.client_name,
        scopes: g.scopes,
        createdAt: g.granted_at,
        lastUsedAt: g.last_used_at,
      })),
      newCorrelationId(),
    );
  });

  app.delete("/authorizations/:grantId", async (c) => {
    const user = c.get("user");
    const db = getSupabaseServiceClient(env);
    const grantId = c.req.param("grantId");
    const removed = await repos.revokeMcpAuthorization(db, user.userId, grantId);
    // Best-effort: also revoke the live grant in the provider's KV store.
    try {
      const provider = (env as { OAUTH_PROVIDER?: { revokeGrant(grantId: string, userId: string): Promise<void> } }).OAUTH_PROVIDER;
      if (provider) await provider.revokeGrant(grantId, user.userId);
    } catch {
      // KV revocation failure must not block the dashboard-side removal.
    }
    if (!removed) return jsonErr(ErrorCode.NOT_FOUND, "connection not found", newCorrelationId(), 404);
    await recordAudit(db, {
      userId: user.userId,
      actorType: "dashboard",
      action: "auth.revoke",
      targetType: "grant",
      targetId: grantId,
    }).catch(() => undefined);
    return jsonOk({ revoked: true, grantId }, newCorrelationId());
  });

  /* Errors */

  app.onError((err, _c) => {
    if (err instanceof LemonAIdeError) {
      return jsonErr(err.code, err.message, newCorrelationId(), httpStatusForErrorCode(err.code), {
        details: typeof err.details === "object" && err.details ? (err.details as Record<string, unknown>) : undefined,
        retryable: err.retryable,
      });
    }
    console.error(JSON.stringify({ level: "error", msg: "api error", err: err.message }));
    return jsonErr(ErrorCode.INTERNAL, "internal error", newCorrelationId(), 500);
  });

  app.notFound((c) => jsonErr(ErrorCode.NOT_FOUND, `no route for ${c.req.method} ${c.req.path}`, newCorrelationId(), 404));

  return app;
}

async function verifyGithubSignature(secret: string, body: string, header: string): Promise<boolean> {
  const match = /^sha256=([0-9a-f]+)$/i.exec(header);
  if (!match) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
  const provided = match[1];
  if (!provided || provided.length % 2 !== 0) return false;
  const sig = new Uint8Array(provided.length / 2);
  for (let i = 0; i < sig.length; i++) sig[i] = Number.parseInt(provided.slice(i * 2, i * 2 + 2), 16);
  if (sig.some((b) => Number.isNaN(b))) return false;
  return crypto.subtle.verify("HMAC", key, sig, new TextEncoder().encode(body));
}

function primaryBase(env: Env): string {
  return env.APP_BASE_DOMAIN.startsWith("http") ? env.APP_BASE_DOMAIN : `https://${env.APP_BASE_DOMAIN}`;
}

async function authenticate(env: Env, authHeader: string | undefined, devHeader: string | undefined): Promise<ApiUser> {
  const db = getSupabaseServiceClient(env);

  if (!isProduction(env) && env.DEV_FAKE_AUTH && devHeader === env.DEV_FAKE_AUTH) {
    const profile = await ensureProfile(db, env.DEV_FAKE_AUTH, { username: env.DEV_FAKE_AUTH });
    return { userId: profile.id, username: profile.username, via: "dashboard" };
  }

  const token = authHeader?.replace(/^Bearer\s+/i, "");
  if (!token) throw new LemonAIdeError(ErrorCode.UNAUTHENTICATED, "missing bearer token");

  const jwt = await verifySupabaseJwt(token, {
    supabaseUrl: env.SUPABASE_URL,
    issuer: env.SUPABASE_JWT_ISSUER,
  });
  const meta = jwt.user_metadata as Record<string, unknown> | undefined;
  const profile = await ensureProfile(db, jwt.sub, {
    username: (meta?.username as string | undefined) ?? jwt.email?.split("@")[0],
    displayName: (meta?.display_name as string | undefined) ?? (meta?.full_name as string | undefined),
  });
  return { userId: profile.id, username: profile.username, via: "dashboard" };
}
