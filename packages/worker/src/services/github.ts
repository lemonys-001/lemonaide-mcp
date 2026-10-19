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

export function connectUrl(env: Env): string {
  const slug = env.GITHUB_APP_SLUG;
  if (!slug) throw new LemonAIdeError(ErrorCode.NOT_CONFIGURED, "GitHub App is not configured");
  return `https://github.com/apps/${slug}/installations/new`;
}

interface InstallationInfo {
  id: number;
  account: { login: string; avatar_url: string; type: string };
  target_type: string;
}

async function requireAppAuth(env: Env): Promise<string> {
  if (!env.GITHUB_APP_ID || !env.GITHUB_APP_PRIVATE_KEY) {
    throw new LemonAIdeError(ErrorCode.NOT_CONFIGURED, "GitHub App credentials are not configured");
  }
  return createAppJwt(env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY);
}

export function hasGithubApp(env: Env): boolean {
  return Boolean(env.GITHUB_APP_ID && env.GITHUB_APP_PRIVATE_KEY);
}

export function hasGithubToken(env: Env): boolean {
  return Boolean(env.BUILD_DISPATCH_TOKEN);
}

/**
 * Token for repo-scoped API calls. Prefers the GitHub App installation when
 * configured; falls back to BUILD_DISPATCH_TOKEN (a PAT / OAuth token) so the
 * platform works without a GitHub App. Only the "app" mode needs an
 * installation row — token mode is a single-account setup.
 */
async function repoApiToken(env: Env, installation?: { installation_id: number } | null): Promise<string> {
  if (hasGithubApp(env)) {
    if (!installation) {
      throw new LemonAIdeError(ErrorCode.NOT_CONFIGURED, "connect your GitHub account first");
    }
    const appJwt = await requireAppAuth(env);
    return createInstallationToken(appJwt, installation.installation_id);
  }
  if (env.BUILD_DISPATCH_TOKEN) return env.BUILD_DISPATCH_TOKEN;
  throw new LemonAIdeError(ErrorCode.NOT_CONFIGURED, "GitHub credentials are not configured (GitHub App or BUILD_DISPATCH_TOKEN)");
}

export async function tokenAccountLogin(env: Env): Promise<string> {
  if (!env.BUILD_DISPATCH_TOKEN) throw new LemonAIdeError(ErrorCode.NOT_CONFIGURED, "BUILD_DISPATCH_TOKEN is not configured");
  const me = (await githubFetch("/user", { token: env.BUILD_DISPATCH_TOKEN })) as { login?: string };
  return me.login ?? "github";
}

async function getInstallation(env: Env, installationId: number): Promise<InstallationInfo> {
  const appJwt = await requireAppAuth(env);
  return (await githubFetch(`/app/installations/${installationId}`, { token: appJwt })) as InstallationInfo;
}

export async function connectInstallation(
  env: Env,
  db: SupabaseClient,
  actor: Actor,
  installationId: number,
): Promise<repos.GithubInstallation> {
  const info = await getInstallation(env, installationId);
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

export async function listInstallationRepos(env: Env, installationId?: number): Promise<{ id: number; name: string; full_name: string; private: boolean }[]> {
  if (installationId && hasGithubApp(env)) {
    const appJwt = await requireAppAuth(env);
    const token = await createInstallationToken(appJwt, installationId);
    const data = (await githubFetch(`/installation/repositories?per_page=100`, { token })) as {
      repositories: { id: number; name: string; full_name: string; private: boolean }[];
    };
    return data.repositories;
  }
  if (!hasGithubApp(env) && env.BUILD_DISPATCH_TOKEN) {
    return (await githubFetch(`/user/repos?per_page=100&sort=pushed`, { token: env.BUILD_DISPATCH_TOKEN })) as {
      id: number; name: string; full_name: string; private: boolean;
    }[];
  }
  throw new LemonAIdeError(ErrorCode.NOT_CONFIGURED, "GitHub credentials are not configured");
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
  if (!installation && !hasGithubApp(env) && !hasGithubToken(env)) {
    throw new LemonAIdeError(ErrorCode.NOT_CONFIGURED, "GitHub credentials are not configured");
  }

  const existing = await repos.getGithubRepository(db, project.id);
  if (existing) {
    throw new LemonAIdeError(ErrorCode.ALREADY_EXISTS, "this project is already connected to a GitHub repository");
  }

  const token = await repoApiToken(env, installation);

  // App mode: repo lives on the installation's account (user or org).
  // Token mode: repo is created under the token owner's account.
  const isOrg = installation ? installation.account_type?.toLowerCase() === "organization" : false;
  const owner = installation ? installation.account_login : await tokenAccountLogin(env);
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
  if (!installation && hasGithubApp(env)) {
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
