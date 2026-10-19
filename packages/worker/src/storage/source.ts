/**
 * Blob storage on Workers KV (free tier; replaces R2 — no card required).
 *
 * Layout:
 *   src/{projectId}/files/{path}          current working tree
 *   src/{projectId}/v/{version}/{path}    immutable snapshots
 *   build/{buildId}/dist/{path}           immutable build output (becomes the deployment prefix)
 *
 * Every value carries KV metadata { size, sha256, contentType? } so prefix
 * listings can return sizes without fetching values (KV `get` does not expose
 * metadata; `list` does). Content types are derived from the extension at
 * serve time via contentTypeFor.
 *
 * All paths passing through here are validated with validateProjectPath first.
 *
 * KV constraints worth remembering: max 25 MiB per value, one write per key
 * per second (snapshots are content-addressed so keys are write-once), free
 * quota 1k writes / 1k lists / 1k deletes per day.
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

interface BlobMeta {
  size?: number;
  sha256?: string;
  contentType?: string;
}

async function putBlob(
  kv: KVNamespace,
  key: string,
  content: ArrayBuffer | Uint8Array | string,
  opts: { sha256?: string; contentType?: string } = {},
): Promise<{ size: number; sha256: string }> {
  const bytes = typeof content === "string" ? encoder.encode(content) : content instanceof Uint8Array ? content : new Uint8Array(content);
  const sha256 = opts.sha256 ?? (await sha256Hex(bytes));
  await kv.put(key, bytes, {
    metadata: { size: bytes.byteLength, sha256, contentType: opts.contentType } satisfies BlobMeta,
  });
  return { size: bytes.byteLength, sha256 };
}

async function listPrefix(kv: KVNamespace, prefix: string): Promise<{ name: string; metadata?: unknown }[]> {
  const out: { name: string; metadata?: unknown }[] = [];
  let cursor: string | undefined;
  do {
    const page = await kv.list({ prefix, cursor });
    out.push(...page.keys);
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return out;
}

async function deleteKeys(kv: KVNamespace, keys: string[]): Promise<void> {
  for (const key of keys) await kv.delete(key);
}

function metaSize(metadata: unknown): number {
  const size = (metadata as BlobMeta | null | undefined)?.size;
  return typeof size === "number" ? size : 0;
}

/* ------------------------------------------------------------------ */
/* Source tree                                                         */
/* ------------------------------------------------------------------ */

export async function putSourceFile(kv: KVNamespace, projectId: string, path: string, content: string): Promise<{ size: number; sha256: string }> {
  const key = safeKey(currentTreeRoot(projectId), path);
  return putBlob(kv, key, content, { contentType: contentTypeFor(path) });
}

export async function getSourceFile(kv: KVNamespace, projectId: string, path: string): Promise<string | null> {
  const key = safeKey(currentTreeRoot(projectId), path);
  return kv.get(key, "text");
}

export async function deleteSourceFile(kv: KVNamespace, projectId: string, path: string): Promise<void> {
  const key = safeKey(currentTreeRoot(projectId), path);
  await kv.delete(key);
}

export async function listSourceFiles(kv: KVNamespace, projectId: string, directory?: string): Promise<FileTreeEntry[]> {
  const root = currentTreeRoot(projectId);
  const prefix = directory ? `${root}/${normalizePath(directory)}/` : `${root}/`;
  const keys = await listPrefix(kv, prefix);
  const entries: FileTreeEntry[] = [];
  for (const key of keys) {
    const rel = key.name.slice(prefix.length);
    if (!rel || rel.endsWith("/")) continue;
    entries.push({
      path: normalizePath(directory ? `${directory}/${rel}` : rel),
      type: "file",
      size: metaSize(key.metadata),
    });
  }
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
  kv: KVNamespace,
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
    const bytes = await kv.get(srcKey, "arrayBuffer");
    if (!bytes) continue;
    totalBytes += bytes.byteLength;
    await putBlob(kv, dstKey, bytes, { sha256: file.sha256 });
    manifest.push({ path: normalizePath(file.path), size: bytes.byteLength, sha256: file.sha256 });
  }

  return { fileCount: manifest.length, totalBytes, manifest: { files: manifest }, storagePrefix: prefix };
}

/** Replace the current tree with the contents of a snapshot (restore). */
export async function restoreSnapshot(
  kv: KVNamespace,
  projectId: string,
  snapshotPrefix: string,
  manifest: { path: string }[],
): Promise<number> {
  const root = currentTreeRoot(projectId);
  const staleKeys = (await listPrefix(kv, `${root}/`)).map((k) => k.name);
  await deleteKeys(kv, staleKeys);

  let restored = 0;
  for (const file of manifest) {
    const srcKey = safeKey(snapshotPrefix, file.path);
    const bytes = await kv.get(srcKey, "arrayBuffer");
    if (!bytes) continue;
    await putBlob(kv, safeKey(root, file.path), bytes);
    restored++;
  }
  return restored;
}

export async function deleteAllSource(kv: KVNamespace, projectId: string): Promise<void> {
  const keys = (await listPrefix(kv, `src/${projectId}/`)).map((k) => k.name);
  await deleteKeys(kv, keys);
}

/* ------------------------------------------------------------------ */
/* Artifacts (build output / published assets)                         */
/* ------------------------------------------------------------------ */

export function buildPrefix(buildId: string): string {
  return `build/${buildId}/dist`;
}

export async function putArtifactFile(
  kv: KVNamespace,
  prefix: string,
  path: string,
  content: ArrayBuffer | string,
  contentType?: string,
): Promise<{ size: number; sha256: string }> {
  const key = safeKey(prefix, path);
  return putBlob(kv, key, content, { contentType: contentType ?? contentTypeFor(path) });
}

export interface ArtifactEntry {
  path: string;
  size: number;
}

export async function listArtifacts(kv: KVNamespace, prefix: string): Promise<ArtifactEntry[]> {
  const keys = await listPrefix(kv, `${prefix}/`);
  const entries: ArtifactEntry[] = [];
  for (const key of keys) {
    const rel = key.name.slice(prefix.length + 1);
    if (!rel || rel.endsWith("/")) continue;
    entries.push({ path: rel, size: metaSize(key.metadata) });
  }
  return entries;
}

export interface BlobObject {
  key: string;
  size: number;
  bytes: ArrayBuffer;
}

export async function getArtifact(kv: KVNamespace, prefix: string, path: string): Promise<BlobObject | null> {
  const key = safeKey(prefix, path);
  const bytes = await kv.get(key, "arrayBuffer");
  if (!bytes) return null;
  return { key, size: bytes.byteLength, bytes };
}

export async function deleteArtifacts(kv: KVNamespace, prefix: string): Promise<void> {
  const keys = (await listPrefix(kv, `${prefix}/`)).map((k) => k.name);
  await deleteKeys(kv, keys);
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
