/**
 * Minimal GitHub REST client used for App installation management, repo
 * creation, and Git Data API pushes. All calls go through fetch() with the
 * token supplied by the caller (app JWT or installation access token).
 */

export class GithubApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly body?: string,
  ) {
    super(message);
    this.name = "GithubApiError";
  }
}

const API_VERSION = "2022-11-28";

export interface GithubRequestOptions {
  method?: string;
  /** Omit for unauthenticated (public-data) requests. */
  token?: string;
  body?: unknown;
  accept?: string;
  /** Return the raw Response instead of parsing JSON (for 204s, zips, etc). */
  raw?: boolean;
}

export async function githubFetch(path: string, opts: GithubRequestOptions): Promise<unknown> {
  const url = path.startsWith("http") ? path : `https://api.github.com${path}`;
  const res = await fetch(url, {
    method: opts.method ?? "GET",
    headers: {
      // GitHub requires a user-agent; Workers fetch sends none by default.
      "user-agent": "lemonaide-mcp-worker",
      accept: opts.accept ?? "application/vnd.github+json",
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
      "x-github-api-version": API_VERSION,
      ...(opts.body ? { "content-type": "application/json" } : {}),
    },
    ...(opts.body ? { body: JSON.stringify(opts.body) } : {}),
  });

  if (opts.raw) {
    if (!res.ok) throw new GithubApiError(res.status, `GitHub ${opts.method ?? "GET"} ${path} → ${res.status}`, await res.text().catch(() => ""));
    return res;
  }

  if (res.status === 204 || res.status === 201) {
    if (!res.ok) throw new GithubApiError(res.status, `GitHub ${opts.method ?? "GET"} ${path} → ${res.status}`, await res.text().catch(() => ""));
    if (res.status === 204) return null;
    return res.json();
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new GithubApiError(res.status, `GitHub ${opts.method ?? "GET"} ${path} → ${res.status}: ${text.slice(0, 300)}`, text);
  }
  return res.json();
}

/* ------------------------------------------------------------------ */
/* Installation tokens (cached until shortly before expiry)            */
/* ------------------------------------------------------------------ */

interface CachedToken {
  token: string;
  expiresAt: number;
}

const tokenCache = new Map<number, CachedToken>();

export async function getInstallationToken(
  installationId: number,
  fetchToken: () => Promise<{ token: string; expires_at: string }>,
): Promise<string> {
  const cached = tokenCache.get(installationId);
  if (cached && cached.expiresAt - Date.now() > 60_000) return cached.token;
  const fresh = await fetchToken();
  tokenCache.set(installationId, {
    token: fresh.token,
    expiresAt: Date.parse(fresh.expires_at) || Date.now() + 55 * 60_000,
  });
  return fresh.token;
}

export async function createInstallationToken(appJwt: string, installationId: number): Promise<string> {
  return getInstallationToken(installationId, async () => {
    const data = (await githubFetch(`/app/installations/${installationId}/access_tokens`, {
      method: "POST",
      token: appJwt,
    })) as { token: string; expires_at: string };
    return data;
  });
}

/* ------------------------------------------------------------------ */
/* Repo-scoped helpers                                                 */
/* ------------------------------------------------------------------ */

export interface GithubRepoRef {
  fullName: string;
  htmlUrl: string;
  cloneUrl: string;
  defaultBranch: string;
  private: boolean;
}

export function parseRepoRef(data: {
  full_name: string;
  html_url: string;
  clone_url: string;
  default_branch: string;
  private: boolean;
}): GithubRepoRef {
  return {
    fullName: data.full_name,
    htmlUrl: data.html_url,
    cloneUrl: data.clone_url,
    defaultBranch: data.default_branch,
    private: data.private,
  };
}

export interface GitCommitInput {
  message: string;
  treeSha: string;
  parents: string[];
}

export interface GitTreeEntry {
  path: string;
  mode: "100644" | "100755" | "040000" | "160000" | "120000";
  type: "blob" | "tree" | "commit";
  sha?: string | null;
  content?: string;
}

export async function createGitBlob(token: string, repoFullName: string, contentBase64: string): Promise<string> {
  const data = (await githubFetch(`/repos/${repoFullName}/git/blobs`, {
    method: "POST",
    token,
    body: { content: contentBase64, encoding: "base64" },
  })) as { sha: string };
  return data.sha;
}

export async function createGitTree(
  token: string,
  repoFullName: string,
  baseTreeSha: string | null,
  entries: GitTreeEntry[],
): Promise<string> {
  const data = (await githubFetch(`/repos/${repoFullName}/git/trees`, {
    method: "POST",
    token,
    body: baseTreeSha ? { base_tree: baseTreeSha, tree: entries } : { tree: entries },
  })) as { sha: string };
  return data.sha;
}

export async function createGitCommit(
  token: string,
  repoFullName: string,
  commit: GitCommitInput,
): Promise<string> {
  const data = (await githubFetch(`/repos/${repoFullName}/git/commits`, {
    method: "POST",
    token,
    body: commit,
  })) as { sha: string };
  return data.sha;
}

export async function updateReference(
  token: string,
  repoFullName: string,
  ref: string,
  sha: string,
): Promise<void> {
  await githubFetch(`/repos/${repoFullName}/git/refs/${ref}`, {
    method: "PATCH",
    token,
    body: { sha, force: false },
  });
}

export async function getRefSha(token: string, repoFullName: string, ref: string): Promise<string | null> {
  try {
    const data = (await githubFetch(`/repos/${repoFullName}/git/ref/${ref}`, { token })) as { object: { sha: string } };
    return data.object.sha;
  } catch (err) {
    if (err instanceof GithubApiError && err.status === 404) return null;
    throw err;
  }
}

export async function getCommitTreeSha(token: string, repoFullName: string, commitSha: string): Promise<string> {
  const data = (await githubFetch(`/repos/${repoFullName}/git/commits/${commitSha}`, { token })) as {
    tree: { sha: string };
  };
  return data.tree.sha;
}
