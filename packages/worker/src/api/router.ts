/**
 * HTTP API surface served under /api/*:
 *
 *  - /api/internal/*  build-runner callbacks (BUILD_RUNNER_TOKEN bearer)
 *  - everything else   dashboard + MCP-adjacent REST, authenticated with a
 *                      Supabase JWT (Bearer) or the dev-only x-dev-user header
 */

import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import { ErrorCode, LemonAIdeError, httpStatusForErrorCode } from "@lemonaide/shared";
import type { Env } from "../env";
import { isProduction } from "../env";
import { JwtVerificationError, verifySupabaseJwt } from "../auth/jwts";
import { getSupabaseServiceClient } from "../db/supabase";
import { ensureProfile, getProfile, recordAudit } from "../db/profiles";
import * as repos from "../db/repos";
import { jsonErr, jsonOk, newCorrelationId } from "../lib/http";
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
import {
  connectInstallation,
  connectUrl,
  createRepoForProject,
  disconnectRepo,
  hasGithubApp,
  readConnectState,
  signConnectState,
  syncProjectToGitHub,
  tokenAccountLogin,
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
  const project = (await repos.getProject(db, user.userId, ref)) ?? (await repos.getProjectBySlug(db, user.userId, ref));
  if (!project) throw new LemonAIdeError(ErrorCode.NOT_FOUND, `no project "${ref}"`);
  return { db, project };
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
  /* Dashboard API (user auth)                                         */
  /* ---------------------------------------------------------------- */

  app.use(async (c, next) => {
    // Public, self-authenticating endpoints:
    //  - GitHub redirect callback: HMAC'd state parameter (browser redirect, no Bearer)
    //  - GitHub webhook: X-Hub-Signature-256 HMAC over the raw body
    if (
      (c.req.method === "GET" && c.req.path === "/api/github/callback") ||
      (c.req.method === "POST" && c.req.path === "/api/github/webhook")
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

  /* Projects */

  app.get("/projects", async (c) => {
    const user = c.get("user");
    const db = getSupabaseServiceClient(env);
    const status = (c.req.query("status") as "active" | "archived" | "all" | undefined) ?? "active";
    const projects = await repos.listProjects(db, user.userId, { status });
    return jsonOk(
      projects.map((p) => ({ ...p, liveUrl: liveUrlFor(env, user.username, p.slug) })),
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
    const appMode = hasGithubApp(env);

    if (installation) {
      return jsonOk(
        { mode: "app", connected: true, account: installation.account_login, connectUrl: null },
        newCorrelationId(),
      );
    }

    // Token mode: no GitHub App — the platform-wide token is the credential.
    if (!appMode && env.BUILD_DISPATCH_TOKEN) {
      let account = "github";
      try {
        account = await tokenAccountLogin(env);
      } catch {
        // profile fetch is best-effort; the badge only needs a label
      }
      return jsonOk({ mode: "token", connected: true, account, connectUrl: null }, newCorrelationId());
    }

    let url: string | null = null;
    try {
      url = appMode ? connectUrl(env) : null;
    } catch {
      url = null;
    }
    return jsonOk(
      { mode: appMode ? "app" : "none", connected: false, account: null, connectUrl: url },
      newCorrelationId(),
    );
  });

  app.get("/github/connect-url", async (c) => {
    const user = c.get("user");
    if (isProduction(env) && !env.GITHUB_APP_SLUG) {
      return jsonErr(ErrorCode.NOT_CONFIGURED, "GitHub App is not configured", newCorrelationId(), 500);
    }
    const state = await signConnectState(env, user.userId);
    const base = connectUrl(env);
    const url = `${base}?setup_action=install&state=${encodeURIComponent(state)}`;
    return jsonOk({ url }, newCorrelationId());
  });

  app.post("/github/webhook", async (c) => {
    const secret = env.GITHUB_APP_WEBHOOK_SECRET;
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
    if (!installationId || !userId) {
      return jsonErr(ErrorCode.INVALID_INPUT, "invalid GitHub connect callback", newCorrelationId(), 400);
    }
    const db = getSupabaseServiceClient(env);
    const profile = await getProfile(db, userId);
    if (!profile) {
      return jsonErr(ErrorCode.NOT_FOUND, "unknown user for connect state", newCorrelationId(), 404);
    }
    await connectInstallation(env, db, { userId: profile.id, username: profile.username, via: "dashboard" }, installationId);
    const redirectTo = String(c.req.query("redirect_to") ?? `${primaryBase(env)}/#/settings`);
    return c.redirect(redirectTo, 302);
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
