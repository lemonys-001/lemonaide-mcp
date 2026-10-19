/**
 * R2 source storage.
 *
 * Layout (SOURCE_BUCKET):
 *   src/{projectId}/files/{path}          current working tree
 *   src/{projectId}/v/{version}/{path}    immutable snapshots
 *
 * Layout (ARTIFACT_BUCKET):
 *   build/{buildId}/dist/{path}           immutable build output (becomes the deployment prefix)
 *
 * All paths passing through here are validated with validateProjectPath first.
 */

import { ErrorCode, LemonAIdeError, normalizePath, validateProjectPath } from "@lemonaide/shared";

export interface SourceFile {
  path: string;
  content: string;
  sha256: string;
  size: number;
}

export interface FileTreeEntry {
  path: string;
  type: "file";
  size: number;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export async function sha256Hex(bytes: ArrayBuffer | Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function currentTreeRoot(projectId: string): string {
  return `src/${projectId}/files`;
}

export function snapshotRoot(projectId: string, version: number): string {
  return `src/${projectId}/v/${version}`;
}

function safeKey(root: string, path: string): string {
  const issue = validateProjectPath(path);
  if (issue) throw new LemonAIdeError(ErrorCode.INVALID_PATH, `invalid path: ${path}`, { details: { issue } });
  return `${root}/${normalizePath(path)}`;
}

export async function putSourceFile(bucket: R2Bucket, projectId: string, path: string, content: string): Promise<{ size: number; sha256: string }> {
  const bytes = encoder.encode(content);
  const key = safeKey(currentTreeRoot(projectId), path);
  const sha = await sha256Hex(bytes);
  await bucket.put(key, bytes, {
    httpMetadata: { contentType: contentTypeFor(path) },
    customMetadata: { sha256: sha },
  });
  return { size: bytes.byteLength, sha256: sha };
}

export async function getSourceFile(bucket: R2Bucket, projectId: string, path: string): Promise<string | null> {
  const key = safeKey(currentTreeRoot(projectId), path);
  const obj = await bucket.get(key);
  if (!obj) return null;
  return decoder.decode(await obj.arrayBuffer());
}

export async function deleteSourceFile(bucket: R2Bucket, projectId: string, path: string): Promise<void> {
  const key = safeKey(currentTreeRoot(projectId), path);
  await bucket.delete(key);
}

export async function listSourceFiles(bucket: R2Bucket, projectId: string, directory?: string): Promise<FileTreeEntry[]> {
  const root = currentTreeRoot(projectId);
  const prefix = directory ? `${root}/${normalizePath(directory)}/` : `${root}/`;
  const entries: FileTreeEntry[] = [];
  let cursor: string | undefined;
  do {
    const page: R2Objects = await bucket.list({ prefix, cursor, include: ["httpMetadata"] });
    for (const obj of page.objects) {
      const rel = obj.key.slice(prefix.length);
      if (!rel || rel.endsWith("/")) continue;
      entries.push({
        path: normalizePath(directory ? `${directory}/${rel}` : rel),
        type: "file",
        size: obj.size,
      });
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  entries.sort((a, b) => a.path.localeCompare(b.path));
  return entries;
}

export interface SnapshotWriteResult {
  fileCount: number;
  totalBytes: number;
  manifest: { files: { path: string; size: number; sha256: string }[] };
  storagePrefix: string;
}

/** Copy the current tree into an immutable snapshot prefix. */
export async function writeSnapshot(
  bucket: R2Bucket,
  projectId: string,
  version: number,
  files: { path: string; sha256: string }[],
): Promise<SnapshotWriteResult> {
  const prefix = snapshotRoot(projectId, version);
  let totalBytes = 0;
  const manifest: { path: string; size: number; sha256: string }[] = [];

  for (const file of files) {
    const srcKey = safeKey(currentTreeRoot(projectId), file.path);
    const dstKey = safeKey(prefix, file.path);
    const obj = await bucket.get(srcKey);
    if (!obj) continue;
    const bytes = await obj.arrayBuffer();
    totalBytes += bytes.byteLength;
    await bucket.put(dstKey, bytes, { customMetadata: { sha256: file.sha256 } });
    manifest.push({ path: normalizePath(file.path), size: bytes.byteLength, sha256: file.sha256 });
  }

  return { fileCount: manifest.length, totalBytes, manifest: { files: manifest }, storagePrefix: prefix };
}

/** Replace the current tree with the contents of a snapshot (restore). */
export async function restoreSnapshot(
  bucket: R2Bucket,
  projectId: string,
  snapshotPrefix: string,
  manifest: { path: string }[],
): Promise<number> {
  // Delete existing current-tree objects, then copy snapshot → current.
  const root = currentTreeRoot(projectId);
  let cursor: string | undefined;
  const staleKeys: string[] = [];
  do {
    const page: R2Objects = await bucket.list({ prefix: `${root}/`, cursor });
    staleKeys.push(...page.objects.map((o) => o.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  if (staleKeys.length > 0) await bucket.delete(staleKeys);

  let restored = 0;
  for (const file of manifest) {
    const srcKey = safeKey(snapshotPrefix, file.path);
    const obj = await bucket.get(srcKey);
    if (!obj) continue;
    await bucket.put(safeKey(root, file.path), await obj.arrayBuffer(), {
      customMetadata: obj.customMetadata,
    });
    restored++;
  }
  return restored;
}

export async function deleteAllSource(bucket: R2Bucket, projectId: string): Promise<void> {
  for (const prefix of [`src/${projectId}/`]) {
    let cursor: string | undefined;
    const keys: string[] = [];
    do {
      const page: R2Objects = await bucket.list({ prefix, cursor });
      keys.push(...page.objects.map((o) => o.key));
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    if (keys.length > 0) await bucket.delete(keys);
  }
}

/* ------------------------------------------------------------------ */
/* Artifacts (build output / published assets)                         */
/* ------------------------------------------------------------------ */

export function buildPrefix(buildId: string): string {
  return `build/${buildId}/dist`;
}

export async function putArtifactFile(bucket: R2Bucket, prefix: string, path: string, content: ArrayBuffer | string, contentType?: string): Promise<{ size: number; sha256: string }> {
  const bytes = typeof content === "string" ? encoder.encode(content) : new Uint8Array(content);
  const key = safeKey(prefix, path);
  const sha = await sha256Hex(bytes);
  await bucket.put(key, bytes, {
    httpMetadata: { contentType: contentType ?? contentTypeFor(path) },
    customMetadata: { sha256: sha },
  });
  return { size: bytes.byteLength, sha256: sha };
}

export interface ArtifactEntry {
  path: string;
  size: number;
}

export async function listArtifacts(bucket: R2Bucket, prefix: string): Promise<ArtifactEntry[]> {
  const entries: ArtifactEntry[] = [];
  let cursor: string | undefined;
  do {
    const page: R2Objects = await bucket.list({ prefix: `${prefix}/`, cursor });
    for (const obj of page.objects) {
      const rel = obj.key.slice(prefix.length + 1);
      if (!rel || rel.endsWith("/")) continue;
      entries.push({ path: rel, size: obj.size });
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return entries;
}

export async function getArtifact(bucket: R2Bucket, prefix: string, path: string): Promise<R2ObjectBody | null> {
  const key = safeKey(prefix, path);
  return bucket.get(key);
}

export async function deleteArtifacts(bucket: R2Bucket, prefix: string): Promise<void> {
  let cursor: string | undefined;
  const keys: string[] = [];
  do {
    const page: R2Objects = await bucket.list({ prefix: `${prefix}/`, cursor });
    keys.push(...page.objects.map((o) => o.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  if (keys.length > 0) await bucket.delete(keys);
}

/* ------------------------------------------------------------------ */

export function contentTypeFor(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith(".html")) return "text/html; charset=utf-8";
  if (lower.endsWith(".css")) return "text/css; charset=utf-8";
  if (lower.endsWith(".js") || lower.endsWith(".mjs")) return "text/javascript; charset=utf-8";
  if (lower.endsWith(".json") || lower.endsWith(".map")) return "application/json; charset=utf-8";
  if (lower.endsWith(".svg")) return "image/svg+xml";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".ico")) return "image/x-icon";
  if (lower.endsWith(".woff2")) return "font/woff2";
  if (lower.endsWith(".woff")) return "font/woff";
  if (lower.endsWith(".txt")) return "text/plain; charset=utf-8";
  if (lower.endsWith(".xml")) return "application/xml";
  if (lower.endsWith(".webmanifest")) return "application/manifest+json";
  if (lower.endsWith(".wasm")) return "application/wasm";
  return "application/octet-stream";
}
