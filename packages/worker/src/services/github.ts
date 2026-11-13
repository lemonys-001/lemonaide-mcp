/**
 * GitHub integration services: connect an App installation, create a backing
 * repository per project, and sync the current source tree via the Git Data
 * API (blobs → tree → commit → ref update).
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { ErrorCode, LemonAIdeError } from "@lemonaide/shared";
import type { Env } from "../env";
import { isProduction } from "../env";
import * as repos from "../db/repos";
import { recordAudit } from "../db/profiles";
import { createAppJwt } from "../github/app";
import {
  GithubApiError,
  createGitBlob,
  createGitCommit,
  createGitTree,
  createInstallationToken,
  getCommitTreeSha,
  getRefSha,
  githubFetch,
} from "../github/api";
import { scanForSecrets, describeFindings } from "../github/scan";
import { getSourceFile, listSourceFiles } from "../storage/source";
import type { Actor } from "./projects";

const encoder = new TextEncoder();

/* ------------------------------------------------------------------ */
/* HMAC state (connect-flow CSRF protection)                           */
/* ------------------------------------------------------------------ */

async function hmacSecret(env: Env): Promise<CryptoKey> {
  const secret = env.CONSENT_SECRET ?? env.SESSION_SECRET;
  if (!secret && isProduction(env)) {
    throw new LemonAIdeError(ErrorCode.NOT_CONFIGURED, "CONSENT_SECRET (or SESSION_SECRET) must be set in production");
  }
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret ?? "lemonaide-dev-state"),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

export async function signConnectState(env: Env, userId: string, ttlMs = 10 * 60_000): Promise<string> {
  const exp = Date.now() + ttlMs;
  const payload = `${userId}.${exp}`;
  const key = await hmacSecret(env);
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return btoa(`${payload}.${sigB64}`).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Verify a connect state and return the bound user id.
 * The callback from GitHub is a bare browser redirect (no Bearer token), so
 * the HMAC'd state is the sole authenticator of the callback.
 */
export async function readConnectState(env: Env, state: string): Promise<string | null> {
  try {
    const decoded = atob(state.replace(/-/g, "+").replace(/_/g, "/"));
    const lastDot = decoded.lastIndexOf(".");
    if (lastDot <= 0) return null;
    const payload = decoded.slice(0, lastDot);
    const sigB64 = decoded.slice(lastDot + 1).replace(/-/g, "+").replace(/_/g, "/");
    const [uid, expStr] = payload.split(".");
    if (!uid || !expStr || Number(expStr) < Date.now()) return null;
    const sigBytes = Uint8Array.from(atob(sigB64), (c) => c.charCodeAt(0));
    const key = await hmacSecret(env);
    const ok = await crypto.subtle.verify("HMAC", key, sigBytes, encoder.encode(payload));
    return ok ? uid : null;
  } catch {
    return null;
  }
}

export async function verifyConnectState(env: Env, state: string, userId: string): Promise<boolean> {
  return (await readConnectState(env, state)) === userId;
}

/* ------------------------------------------------------------------ */
/* Installations                                                       */
/* ------------------------------------------------------------------ */

/**
 * GitHub App credentials. Normally env secrets; the manifest flow lets the
 * owner register the app in one click, which stores the generated credentials
 * in KV instead (no redeploy needed). Env secrets win when present.
 */
export interface GithubAppConfig {
  appId: string;
  slug: string;
  clientId: string;
  clientSecret: string;
  privateKeyPem: string;
  webhookSecret: string;
}

const APP_CONFIG_KEY = "ghapp:app-config";
let appConfigCache: { cfg: GithubAppConfig | null; at: number } | null = null;

export async function getGithubAppConfig(env: Env): Promise<GithubAppConfig | null> {
  if (env.GITHUB_APP_ID && env.GITHUB_APP_PRIVATE_KEY) {
    return {
      appId: env.GITHUB_APP_ID,
      slug: env.GITHUB_APP_SLUG ?? "",
      clientId: env.GITHUB_APP_CLIENT_ID ?? "",
      clientSecret: env.GITHUB_APP_CLIENT_SECRET ?? "",
      privateKeyPem: env.GITHUB_APP_PRIVATE_KEY,
      webhookSecret: env.GITHUB_APP_WEBHOOK_SECRET ?? "",
    };
  }
  if (appConfigCache && Date.now() - appConfigCache.at < 60_000) return appConfigCache.cfg;
  let cfg: GithubAppConfig | null = null;
  try {
    const raw = await env.OAUTH_KV.get(APP_CONFIG_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as GithubAppConfig;
      if (parsed.appId && parsed.privateKeyPem) cfg = parsed;
    }
  } catch {
    // unreadable/absent config = not configured
  }
  appConfigCache = { cfg, at: Date.now() };
  return cfg;
}

export async function saveGithubAppConfig(env: Env, cfg: GithubAppConfig): Promise<void> {
  await env.OAUTH_KV.put(APP_CONFIG_KEY, JSON.stringify(cfg));
  appConfigCache = { cfg, at: Date.now() };
}

export function connectUrlFor(slug: string): string {
  if (!slug) throw new LemonAIdeError(ErrorCode.NOT_CONFIGURED, "GitHub App is not configured");
  return `https://github.com/apps/${slug}/installations/new`;
}

export async function connectUrl(env: Env): Promise<string> {
  const cfg = await getGithubAppConfig(env);
  return connectUrlFor(cfg?.slug ?? "");
}

export async function hasGithubApp(env: Env): Promise<boolean> {
  return (await getGithubAppConfig(env)) !== null;
}

interface InstallationInfo {
  id: number;
  account: { login: string; avatar_url: string; type: string };
  target_type: string;
}

async function requireAppAuth(env: Env): Promise<string> {
  const cfg = await getGithubAppConfig(env);
  if (!cfg) {
    throw new LemonAIdeError(ErrorCode.NOT_CONFIGURED, "GitHub App credentials are not configured");
  }
  return createAppJwt(cfg.appId, cfg.privateKeyPem);
}

/**
 * Token for repo-scoped API calls: always the caller's own GitHub App
 * installation. The platform BUILD_DISPATCH_TOKEN is NOT a repo credential —
 * it only dispatches builds — so repos can never land under the operator's
 * account.
 */
async function repoApiToken(env: Env, installation: { installation_id: number } | null | undefined): Promise<string> {
  if (!(await hasGithubApp(env))) {
    throw new LemonAIdeError(ErrorCode.NOT_CONFIGURED, "GitHub sync is disabled (GitHub App not configured)");
  }
  if (!installation) {
    throw new LemonAIdeError(ErrorCode.NOT_CONFIGURED, "connect your GitHub account first");
  }
  const appJwt = await requireAppAuth(env);
  return createInstallationToken(appJwt, installation.installation_id);
}

/* ------------------------------------------------------------------ */
/* App manifest flow (one-click app registration by the platform owner) */
/* ------------------------------------------------------------------ */

function primaryBase(env: Env): string {
  return env.APP_BASE_DOMAIN.startsWith("http") ? env.APP_BASE_DOMAIN : `https://${env.APP_BASE_DOMAIN}`;
}

export function buildAppManifest(env: Env, setupState: string): Record<string, unknown> {
  const base = primaryBase(env);
  return {
    name: "LemonAIde",
    url: `${base}`,
    hook_attributes: { url: `${base}/api/github/webhook`, active: true },
    redirect_url: `${base}/api/github/manifest-setup`,
    callback_urls: [`${base}/api/github/callback`],
    setup_url: `${base}/api/github/callback?state=${encodeURIComponent(setupState)}`,
    setup_on_update: true,
    description: "Publish LemonAIde projects to your own GitHub repositories",
    public: false,
    default_permissions: { contents: "write", metadata: "read", administration: "write" },
    // No default_events: "installation" is rejected by the manifest validator,
    // and installation webhooks are delivered to apps regardless.
    request_oauth_on_install: false,
  };
}

export interface ManifestConversion {
  id: number;
  slug: string;
  html_url: string;
  pem: string;
  webhook_secret: string;
  client_id: string;
  client_secret: string;
}

export async function exchangeManifestCode(code: string): Promise<ManifestConversion> {
  const res = await fetch(`https://api.github.com/app-manifests/${encodeURIComponent(code)}/conversions`, {
    method: "POST",
    headers: {
      "user-agent": "lemonaide-mcp-worker",
      accept: "application/vnd.github+json",
    },
  });
  if (!res.ok) {
    throw new LemonAIdeError(ErrorCode.INTERNAL, `GitHub manifest conversion failed (${res.status})`);
  }
  return (await res.json()) as ManifestConversion;
}

async function getInstallation(env: Env, installationId: number): Promise<InstallationInfo> {
  const appJwt = await requireAppAuth(env);
  return (await githubFetch(`/app/installations/${installationId}`, { token: appJwt })) as InstallationInfo;
}

/**
 * Point the app's setup_url (held by GitHub itself) at a fresh signed state.
 * The state baked into the app at creation expires, so every install/update
 * callback would fail with "invalid connect callback" — this repairs it.
 * Best-effort: false on any error (e.g. key issues), never throws.
 */
export async function refreshAppSetupUrl(env: Env, userId: string, ttlMs = 90 * 24 * 60 * 60_000): Promise<boolean> {
  try {
    const appJwt = await requireAppAuth(env);
    const state = await signConnectState(env, userId, ttlMs);
    await githubFetch("/app", {
      method: "PATCH",
      token: appJwt,
      body: { setup_url: `${primaryBase(env)}/api/github/callback?state=${encodeURIComponent(state)}` },
    });
    return true;
  } catch {
    return false;
  }
}

/** Login on an installation, for attributing stale-state callbacks. Best-effort. */
export async function getInstallationLogin(env: Env, installationId: number): Promise<string | null> {
  try {
    const info = await getInstallation(env, installationId);
    return info.account?.login ?? null;
  } catch {
    return null;
  }
}

export async function connectInstallation(
  env: Env,
  db: SupabaseClient,
  actor: Actor,
  installationId: number,
): Promise<repos.GithubInstallation> {  const info = await getInstallation(env, installationId);
  const row = await repos.upsertGithubInstallation(db, {
    userId: actor.userId,
    installationId: info.id,
    accountLogin: info.account.login,
    accountType: info.target_type,
  });
  await recordAudit(db, {
    userId: actor.userId,
    actorType: actor.via,
    action: "github.connect",
    targetType: "github_installation",
    targetId: String(info.id),
    meta: { account: info.account.login },
  });
  return row;
}

/* ------------------------------------------------------------------ */
/* Per-project repository                                              */
/* ------------------------------------------------------------------ */

export async function createRepoForProject(
  env: Env,
  db: SupabaseClient,
  actor: Actor,
  project: repos.Project,
  opts: { privateRepo?: boolean } = {},
): Promise<{ repo: repos.GithubRepository; repoFullName: string; repoUrl: string }> {
  const installation = await repos.getGithubInstallation(db, actor.userId);
  if (!installation) {
    throw new LemonAIdeError(ErrorCode.NOT_CONFIGURED, "connect your GitHub account first");
  }

  const existing = await repos.getGithubRepository(db, project.id);
  if (existing) {
    throw new LemonAIdeError(ErrorCode.ALREADY_EXISTS, "this project is already connected to a GitHub repository");
  }

  const token = await repoApiToken(env, installation);

  // Repo lives on the installation's account (user or org) — never the platform's.
  const isOrg = installation.account_type?.toLowerCase() === "organization";
  const owner = installation.account_login;
  const name = project.slug;
  const body = {
    name,
    description: project.description?.slice(0, 350) ?? `Published from LemonAIde — ${project.name}`,
    private: opts.privateRepo ?? true,
    auto_init: false,
    has_issues: false,
    has_projects: false,
    has_wiki: false,
  };

  let created: { id: number; full_name: string; html_url: string; default_branch: string; private: boolean };
  try {
    created = (await githubFetch(isOrg ? `/orgs/${owner}/repos` : `/user/repos`, {
      method: "POST",
      token,
      body,
    })) as typeof created;
  } catch (err) {
    if (err instanceof GithubApiError && err.status === 422) {
      throw new LemonAIdeError(ErrorCode.ALREADY_EXISTS, `repository "${owner}/${name}" already exists on GitHub — rename the project or pick another slug`);
    }
    throw err;
  }

  const repo = await repos.upsertGithubRepository(db, {
    projectId: project.id,
    installationId: installation?.installation_id ?? null,
    repoFullName: created.full_name,
    repoUrl: created.html_url,
    defaultBranch: created.default_branch ?? "main",
    isPrivate: created.private,
  });

  await recordAudit(db, {
    userId: actor.userId,
    actorType: actor.via,
    action: "github.create_repo",
    targetType: "project",
    targetId: project.id,
    meta: { repo: created.full_name },
  });

  return { repo, repoFullName: created.full_name, repoUrl: created.html_url };
}

export interface SyncResult {
  commitSha: string;
  fileCount: number;
  repoFullName: string;
  secretFindings: number;
}

export async function syncProjectToGitHub(
  env: Env,
  db: SupabaseClient,
  actor: Actor,
  project: repos.Project,
): Promise<SyncResult> {
  const repoRow = await repos.getGithubRepository(db, project.id);
  if (!repoRow) throw new LemonAIdeError(ErrorCode.NOT_FOUND, "project is not connected to a GitHub repository");
  const installation = await repos.getGithubInstallation(db, actor.userId);
  if (!installation && (await hasGithubApp(env))) {
    throw new LemonAIdeError(ErrorCode.NOT_CONFIGURED, "GitHub installation no longer available");
  }

  const files = await listSourceFiles(env.BLOB_STORE, project.id);
  if (files.length === 0) throw new LemonAIdeError(ErrorCode.INVALID_INPUT, "project has no files to sync");

  // Load contents (listSourceFiles is metadata-only).
  const contents: { path: string; content: string }[] = [];
  for (const entry of files) {
    const content = await getSourceFile(env.BLOB_STORE, project.id, entry.path);
    contents.push({ path: entry.path, content: content ?? "" });
  }

  // Never push secrets out to GitHub.
  const findings = scanForSecrets(contents);
  if (findings.length > 0) {
    throw new LemonAIdeError(ErrorCode.GITHUB_SECRET_DETECTED, `refusing to sync: ${describeFindings(findings)}`, {
      details: { findings },
    });
  }

  const token = await repoApiToken(env, installation);
  const fullName = repoRow.repo_full_name;
  const branch = repoRow.default_branch;

  const headSha = await getRefSha(token, fullName, `heads/${branch}`);
  const baseTreeSha = headSha ? await getCommitTreeSha(token, fullName, headSha) : null;

  const entries = [];
  for (const file of contents) {
    const sha = await createGitBlob(token, fullName, b64FromText(file.content));
    entries.push({ path: file.path, mode: "100644" as const, type: "blob" as const, sha });
  }

  const treeSha = await createGitTree(token, fullName, baseTreeSha, entries);
  const commitSha = await createGitCommit(token, fullName, {
    message: `Sync from LemonAIde (${files.length} files)`,
    treeSha,
    parents: headSha ? [headSha] : [],
  });

  if (headSha) {
    await githubFetch(`/repos/${fullName}/git/refs/heads/${branch}`, {
      method: "PATCH",
      token,
      body: { sha: commitSha, force: false },
    });
  } else {
    await githubFetch(`/repos/${fullName}/git/refs`, {
      method: "POST",
      token,
      body: { ref: `refs/heads/${branch}`, sha: commitSha },
    });
  }

  await repos.updateGithubLastSync(db, project.id, commitSha);

  await recordAudit(db, {
    userId: actor.userId,
    actorType: actor.via,
    action: "github.sync",
    targetType: "project",
    targetId: project.id,
    meta: { repo: fullName, commitSha, fileCount: files.length },
  });

  return { commitSha, fileCount: files.length, repoFullName: fullName, secretFindings: 0 };
}

export async function disconnectRepo(
  db: SupabaseClient,
  actor: Actor,
  project: repos.Project,
): Promise<void> {
  const removed = await repos.deleteGithubRepository(db, project.id);
  if (!removed) throw new LemonAIdeError(ErrorCode.NOT_FOUND, "project is not connected to a GitHub repository");
  await recordAudit(db, {
    userId: actor.userId,
    actorType: actor.via,
    action: "github.disconnect",
    targetType: "project",
    targetId: project.id,
  });
}

function b64FromText(text: string): string {
  const bytes = encoder.encode(text);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}
