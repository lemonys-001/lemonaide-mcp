/**
 * Build pipeline services: snapshot creation, build jobs, runner callbacks,
 * artifact upload, and log storage. Actual compilation happens in the
 * isolated GitHub Actions runner — never inside this Worker.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { ErrorCode, FRAMEWORK_BUILD_CONFIG, LIMITS, LemonAIdeError, type BuildStatus } from "@lemonaide/shared";
import type { Env } from "../env";
import * as repos from "../db/repos";
import { recordAudit, recordUsageSafe } from "../db/usage-audit";
import { validateProject, issuesToError, type Actor } from "./projects";
import { buildPrefix, putArtifactFile, writeSnapshot } from "../storage/source";

const encoder = new TextEncoder();

export interface StartedBuild {
  build: repos.BuildRow;
  reused: boolean;
}

export async function startBuild(
  env: Env,
  db: SupabaseClient,
  actor: Actor,
  project: repos.Project,
  opts: { installDependencies?: boolean; idempotencyKey?: string } = {},
): Promise<StartedBuild> {
  if (opts.idempotencyKey) {
    const existing = await repos.findByIdempotencyKey(db, opts.idempotencyKey);
    if (existing) {
      if (existing.project_id !== project.id) {
        throw new LemonAIdeError(ErrorCode.CONFLICT, "idempotency key belongs to another project");
      }
      return { build: existing, reused: true };
    }
  }

  const buildsToday = await repos.countUsageToday(db, actor.userId, "build");
  if (buildsToday >= LIMITS.maxBuildsPerDay) {
    throw new LemonAIdeError(ErrorCode.QUOTA_EXCEEDED, `daily build limit reached (${LIMITS.maxBuildsPerDay})`, { retryable: true });
  }

  const issues = await validateProject(env, project);
  const validationError = issuesToError(issues);
  if (validationError) throw validationError;

  // Immutable source snapshot for this build.
  const fileRows = await repos.listFileRows(db, project.id);
  const version = await repos.nextProjectVersion(db, project.id);
  const snap = await writeSnapshot(
    env.BLOB_STORE,
    project.id,
    version,
    fileRows.map((f) => ({ path: f.path, sha256: f.sha256 })),
  );
  const versionRow = await repos.insertProjectVersion(db, {
    projectId: project.id,
    version,
    manifest: snap.manifest,
    fileCount: snap.fileCount,
    totalBytes: snap.totalBytes,
    storagePrefix: snap.storagePrefix,
    createdBy: actor.userId,
  });

  const config = FRAMEWORK_BUILD_CONFIG[project.framework];
  const build = await repos.insertBuild(db, {
    projectId: project.id,
    versionId: versionRow.id,
    framework: project.framework,
    installCommand: opts.installDependencies === false ? "" : config.installCommand,
    buildCommand: config.buildCommand,
    ...(opts.idempotencyKey ? { idempotencyKey: opts.idempotencyKey } : {}),
  });

  await recordUsageSafe(db, { userId: actor.userId, projectId: project.id, kind: "build" });
  await recordAudit(db, {
    userId: actor.userId,
    actorType: actor.via,
    action: "build.start",
    targetType: "build",
    targetId: build.id,
    meta: { projectId: project.id, framework: project.framework, version },
  });

  // Queue the dispatch; failure surfaces as build failure (never a fake success).
  try {
    await env.BUILD_QUEUE.send({ buildId: build.id, projectId: project.id });
  } catch (err) {
    await repos.updateBuild(db, build.id, {
      status: "failed",
      error_code: ErrorCode.SERVICE_UNAVAILABLE,
      error_message: `failed to queue build: ${err instanceof Error ? err.message : String(err)}`,
      finished_at: new Date().toISOString(),
    });
    throw new LemonAIdeError(ErrorCode.SERVICE_UNAVAILABLE, "failed to queue build", { retryable: true, cause: err });
  }

  return { build, reused: false };
}

/** Queue consumer: dispatch the isolated runner (GitHub Actions workflow). */
export async function dispatchBuild(env: Env, db: SupabaseClient, buildId: string): Promise<void> {
  const build = await repos.getBuild(db, buildId);
  if (!build) return;
  if (build.status !== "queued") return;

  try {
    const runId = await dispatchGitHubActionsWorkflow(env, buildId);
    await repos.updateBuild(db, buildId, { status: "running", runner_run_id: runId, started_at: new Date().toISOString() });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await repos.updateBuild(db, buildId, {
      status: "failed",
      error_code: ErrorCode.SERVICE_UNAVAILABLE,
      error_message: `runner dispatch failed: ${message}`,
      finished_at: new Date().toISOString(),
    });
    console.error(JSON.stringify({ level: "error", msg: "runner dispatch failed", buildId, err: message }));
  }
}

/**
 * Trigger the platform build-runner workflow via the GitHub App installation
 * on the platform repository, falling back to a personal dispatch token.
 */
async function dispatchGitHubActionsWorkflow(env: Env, buildId: string): Promise<number | null> {
  const [owner, repo] = platformRepo(env);
  const workflowFile = "build-runner.yml";
  const url = `https://api.github.com/repos/${owner}/${repo}/actions/workflows/${workflowFile}/dispatches`;

  const token = await platformToken(env, owner, repo);
  const res = await fetch(url, {
    method: "POST",
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "x-gitHub-api-version": "2022-11-28",
      "content-type": "application/json",
    },
    body: JSON.stringify({ ref: "main", inputs: { build_id: buildId } }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`workflow dispatch ${res.status}: ${text.slice(0, 300)}`);
  }
  return null; // run id is not returned by the dispatch API; runner reports it back
}

function platformRepo(env: Env): [string, string] {
  const repoEnv = (globalThis as { __PLATFORM_REPO__?: string }).__PLATFORM_REPO__;
  const value = repoEnv ?? env.GITHUB_APP_SLUG ?? "lemonys-001/lemonaide-mcp";
  const [owner, repo] = value.split("/");
  return [owner ?? "lemonys-001", repo ?? "lemonaide-mcp"];
}

async function platformToken(env: Env, owner: string, repo: string): Promise<string> {
  if (env.BUILD_DISPATCH_TOKEN) return env.BUILD_DISPATCH_TOKEN;
  if (!env.GITHUB_APP_ID || !env.GITHUB_APP_PRIVATE_KEY) {
    throw new Error("no dispatch credentials configured (BUILD_DISPATCH_TOKEN or GitHub App)");
  }
  const { createAppJwt } = await import("../github/app");
  const appJwt = await createAppJwt(env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY);
  const installRes = await fetch(
    `https://api.github.com/app/installations?per_page=100`,
    { headers: { accept: "application/vnd.github+json", authorization: `Bearer ${appJwt}` } },
  );
  if (!installRes.ok) throw new Error(`list installations ${installRes.status}`);
  const installations = (await installRes.json()) as { id: number; repository_selection: string }[];
  if (installations.length === 0) throw new Error("GitHub App is not installed on any account");

  for (const installation of installations) {
    const tokRes = await fetch(`https://api.github.com/app/installations/${installation.id}/access_tokens`, {
      method: "POST",
      headers: { accept: "application/vnd.github+json", authorization: `Bearer ${appJwt}` },
    });
    if (!tokRes.ok) continue;
    const tok = (await tokRes.json()) as { token: string };
    const repoCheck = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
      headers: { accept: "application/vnd.github+json", authorization: `Bearer ${tok.token}` },
    });
    if (repoCheck.ok) return tok.token;
  }
  throw new Error(`no installation can access ${owner}/${repo}`);
}

/* ------------------------------------------------------------------ */
/* Runner callbacks (authenticated with BUILD_RUNNER_TOKEN)            */
/* ------------------------------------------------------------------ */

export function verifyRunnerToken(env: Env, presented: string | null): boolean {
  if (!env.BUILD_RUNNER_TOKEN || !presented) return false;
  const a = encoder.encode(presented);
  const b = encoder.encode(env.BUILD_RUNNER_TOKEN);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] as number) ^ (b[i] as number);
  return diff === 0;
}

export interface SourceBundle {
  projectId: string;
  buildId: string;
  framework: string;
  installCommand: string;
  buildCommand: string;
  outputDir: string;
  files: { path: string; content: string }[]; // content = utf-8 (text projects only in v1)
}

export async function buildSourceBundle(env: Env, db: SupabaseClient, buildId: string): Promise<SourceBundle> {
  const build = await repos.getBuild(db, buildId);
  if (!build) throw new LemonAIdeError(ErrorCode.NOT_FOUND, "build not found");

  // Read from the build's immutable snapshot when available, else the current tree.
  let sourceRoot = `src/${build.project_id}/files`;
  if (build.version_id) {
    const { data } = await db
      .from("project_versions")
      .select("storage_prefix")
      .eq("id", build.version_id)
      .maybeSingle();
    if (data?.storage_prefix) sourceRoot = data.storage_prefix;
  }

  const fileRows = await repos.listFileRows(db, build.project_id);
  const files: { path: string; content: string }[] = [];
  let totalBytes = 0;

  for (const row of fileRows) {
    const bytes = await env.BLOB_STORE.get(`${sourceRoot}/${row.path}`, "arrayBuffer");
    if (!bytes) continue;
    totalBytes += bytes.byteLength;
    if (totalBytes > LIMITS.projectTotalMaxBytes) {
      throw new LemonAIdeError(ErrorCode.PAYLOAD_TOO_LARGE, "project source exceeds bundle limit");
    }
    files.push({ path: row.path, content: new TextDecoder().decode(bytes) });
  }

  const config = FRAMEWORK_BUILD_CONFIG[build.framework as keyof typeof FRAMEWORK_BUILD_CONFIG];
  const installDisabled = build.install_command === "";
  return {
    projectId: build.project_id,
    buildId: build.id,
    framework: build.framework,
    installCommand: installDisabled ? "" : config.installCommand,
    buildCommand: config.buildCommand,
    outputDir: config.outputDir,
    files,
  };
}

export async function reportBuildRunning(db: SupabaseClient, buildId: string, runnerRunId?: number): Promise<void> {
  const build = await repos.getBuild(db, buildId);
  if (!build) throw new LemonAIdeError(ErrorCode.NOT_FOUND, "build not found");
  if (build.status === "queued" || build.status === "running") {
    await repos.updateBuild(db, buildId, {
      status: "running",
      started_at: build.started_at ?? new Date().toISOString(),
      ...(runnerRunId ? { runner_run_id: runnerRunId } : {}),
    });
  }
}

const LOG_MAX = LIMITS.buildLogMaxBytes;

export async function appendBuildLogs(env: Env, db: SupabaseClient, buildId: string, chunk: string): Promise<void> {
  const key = `build/${buildId}/logs.txt`;
  const current = (await env.BLOB_STORE.get(key)) ?? "";
  if (current.length >= LOG_MAX) {
    await repos.updateBuild(db, buildId, { log_truncated: true });
    return;
  }
  const appended = current + chunk;
  const truncated = appended.length > LOG_MAX;
  await env.BLOB_STORE.put(key, truncated ? appended.slice(0, LOG_MAX) : appended, {
    metadata: { size: Math.min(appended.length, LOG_MAX), contentType: "text/plain; charset=utf-8" },
  });
  if (truncated) await repos.updateBuild(db, buildId, { log_truncated: true });
}

export async function readBuildLogs(
  env: Env,
  buildId: string,
  offset: number,
  limit: number,
): Promise<{ content: string; nextOffset: number; total: number; truncated: boolean }> {
  const key = `build/${buildId}/logs.txt`;
  const text = (await env.BLOB_STORE.get(key)) ?? "";
  if (text === null) return { content: "", nextOffset: 0, total: 0, truncated: false };
  const slice = text.slice(offset, offset + limit);
  return { content: slice, nextOffset: offset + slice.length, total: text.length, truncated: false };
}

export interface ArtifactBatch {
  files: { path: string; content: string; encoding?: "base64" | "utf8" }[];
}

const SAFE_OUTPUT_EXT = new Set([
  ".html", ".htm", ".css", ".js", ".mjs", ".cjs", ".json", ".map", ".txt", ".xml", ".webmanifest",
  ".svg", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".ico", ".woff", ".woff2", ".ttf", ".otf",
  ".wasm", ".mp4", ".webm", ".mp3", ".wav", ".pdf", ".br", ".gz",
]);

export async function storeArtifactBatch(
  env: Env,
  db: SupabaseClient,
  buildId: string,
  batch: ArtifactBatch,
): Promise<{ stored: number; totalBytes: number }> {
  const build = await repos.getBuild(db, buildId);
  if (!build) throw new LemonAIdeError(ErrorCode.NOT_FOUND, "build not found");
  if (build.status !== "running") {
    throw new LemonAIdeError(ErrorCode.BUILD_INVALID_STATE, `build is ${build.status}`);
  }

  const prefix = buildPrefix(buildId);
  let stored = 0;
  let batchBytes = 0;
  let runningBytes = build.artifact_bytes ?? 0;
  let runningCount = build.artifact_count ?? 0;

  for (const file of batch.files) {
    if (file.path.length > 400 || file.path.includes("..") || file.path.startsWith("/") || file.path.includes("\\")) {
      throw new LemonAIdeError(ErrorCode.INVALID_PATH, `unsafe artifact path: ${file.path}`);
    }
    const lower = file.path.toLowerCase();
    const dot = lower.lastIndexOf(".");
    const ext = dot >= 0 ? lower.slice(dot) : "";
    if (!SAFE_OUTPUT_EXT.has(ext)) {
      throw new LemonAIdeError(ErrorCode.OUTPUT_VALIDATION_FAILED, `artifact file type not allowed: ${file.path}`);
    }

    const bytes = file.encoding === "base64" ? Uint8Array.from(atob(file.content), (c) => c.charCodeAt(0)) : encoder.encode(file.content);
    batchBytes += bytes.byteLength;
    runningBytes += bytes.byteLength;
    runningCount += 1;

    if (runningBytes > LIMITS.artifactMaxBytes) {
      throw new LemonAIdeError(ErrorCode.OUTPUT_VALIDATION_FAILED, "build output exceeds the size limit");
    }
    if (runningCount > LIMITS.artifactMaxFiles) {
      throw new LemonAIdeError(ErrorCode.OUTPUT_VALIDATION_FAILED, "build output exceeds the file count limit");
    }

    await putArtifactFile(env.BLOB_STORE, prefix, file.path, bytes as unknown as ArrayBuffer);
    stored++;
  }

  await repos.updateBuild(db, buildId, {
    artifact_prefix: prefix,
    artifact_count: runningCount,
    artifact_bytes: runningBytes,
  });

  return { stored, totalBytes: batchBytes };
}

export async function completeBuild(
  env: Env,
  db: SupabaseClient,
  buildId: string,
  outcome: { status: "succeeded" | "failed" | "canceled"; errorCode?: string; errorMessage?: string; runnerRunId?: number },
): Promise<void> {
  void env;
  const build = await repos.getBuild(db, buildId);
  if (!build) throw new LemonAIdeError(ErrorCode.NOT_FOUND, "build not found");
  if (build.status === outcome.status) return;

  const patch: Parameters<typeof repos.updateBuild>[2] = {
    status: outcome.status as BuildStatus,
    finished_at: new Date().toISOString(),
    ...(outcome.runnerRunId ? { runner_run_id: outcome.runnerRunId } : {}),
  };

  if (outcome.status === "failed" || outcome.status === "canceled") {
    patch.error_code = outcome.errorCode ?? (outcome.status === "canceled" ? ErrorCode.BUILD_CANCELED : ErrorCode.BUILD_FAILED);
    patch.error_message = outcome.errorMessage ?? null;
  } else if (!build.artifact_prefix) {
    patch.status = "failed";
    patch.error_code = ErrorCode.OUTPUT_VALIDATION_FAILED;
    patch.error_message = "runner reported success but uploaded no artifacts";
    patch.finished_at = new Date().toISOString();
  }

  await repos.updateBuild(db, buildId, patch);
}

export async function validateBuildOutput(env: Env, build: repos.BuildRow): Promise<void> {
  if (build.status !== "succeeded") {
    throw new LemonAIdeError(ErrorCode.BUILD_INVALID_STATE, `build is ${build.status}`);
  }
  if (!build.artifact_prefix) {
    throw new LemonAIdeError(ErrorCode.OUTPUT_VALIDATION_FAILED, "build has no artifacts");
  }
  const { listArtifacts } = await import("../storage/source");
  const artifacts = await listArtifacts(env.BLOB_STORE, build.artifact_prefix);
  if (artifacts.length === 0) {
    throw new LemonAIdeError(ErrorCode.OUTPUT_VALIDATION_FAILED, "build produced no output files");
  }
  const hasEntry = artifacts.some((a) => a.path === "index.html" || a.path.endsWith("/index.html"));
  if (!hasEntry) {
    throw new LemonAIdeError(ErrorCode.OUTPUT_VALIDATION_FAILED, "build output has no index.html entry point");
  }
}
