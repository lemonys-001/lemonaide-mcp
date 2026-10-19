/**
 * Path validation for user-supplied project-relative file paths.
 * Every path entering storage, R2 keys, or git trees MUST pass through here.
 */

const MAX_PATH_LENGTH = 400;

export type PathIssue =
  | "empty"
  | "too_long"
  | "absolute"
  | "traversal"
  | "backslash"
  | "nul"
  | "reserved_prefix";

const RESERVED_PREFIXES = ["node_modules/", ".git/", ".wrangler/", ".github/"];

/** Normalize separators and reject anything that could escape the project root. */
export function validateProjectPath(path: string): PathIssue | null {
  if (!path) return "empty";
  if (path.includes("\0")) return "nul";
  if (path.includes("\\")) return "backslash";
  if (path.length > MAX_PATH_LENGTH) return "too_long";
  if (path.startsWith("/") || /^[a-zA-Z]:/.test(path)) return "absolute";

  const segments = path.split("/");
  for (const seg of segments) {
    if (seg === "" || seg === "." || seg === "..") return "traversal";
    if (seg.length > 100) return "too_long";
  }

  // The "." segment check above already rejects "..", but be explicit for clarity.
  if (segments.includes("..")) return "traversal";

  const normalized = normalizePath(path);
  if (RESERVED_PREFIXES.some((p) => normalized.startsWith(p))) return "reserved_prefix";

  return null;
}

/** Collapse duplicate slashes and trailing slash (after validation). */
export function normalizePath(path: string): string {
  return path
    .split("/")
    .filter((s) => s.length > 0 && s !== ".")
    .join("/");
}

export function isValidProjectPath(path: string): boolean {
  return validateProjectPath(path) === null;
}

/**
 * Join a project root prefix with a validated relative path into an R2/git key.
 * Throws if the result could escape root (defense in depth).
 */
export function joinKey(root: string, relPath: string): string {
  const issue = validateProjectPath(relPath);
  if (issue) throw new Error(`invalid project path (${issue}): ${relPath}`);
  const key = `${root.replace(/\/+$/, "")}/${normalizePath(relPath)}`;
  if (!key.startsWith(root.replace(/\/+$/, "") + "/")) {
    throw new Error(`path escapes root: ${relPath}`);
  }
  return key;
}

/** True when the key is inside the given root prefix. */
export function keyInRoot(key: string, root: string): boolean {
  const normalizedRoot = root.replace(/\/+$/, "");
  return key === normalizedRoot || key.startsWith(normalizedRoot + "/");
}
