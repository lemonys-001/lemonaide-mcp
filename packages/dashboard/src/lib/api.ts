/** Typed client for the LemonAIde Worker API (/api/*). */

import { getAccessToken } from "./supabase";

export interface ApiEnvelope<T> {
  ok: boolean;
  data?: T;
  error?: { code: string; message: string; details?: Record<string, unknown> };
  correlationId: string;
}

export class ApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(method: string, path: string, body?: unknown, query?: Record<string, string>): Promise<T> {
  const token = await getAccessToken();
  const url = new URL(path, window.location.origin);
  if (query) {
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  }
  const res = await fetch(url, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const payload = (await res.json().catch(() => null)) as ApiEnvelope<T> | null;
  if (!payload || payload.ok === false || !res.ok) {
    throw new ApiError(
      payload?.error?.code ?? `HTTP_${res.status}`,
      payload?.error?.message ?? `request failed (${res.status})`,
      res.status,
    );
  }
  return payload.data as T;
}

/* ------------------------------------------------------------------ */
/* Resource shapes (mirror the Worker API)                             */
/* ------------------------------------------------------------------ */

export interface Project {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  framework: string;
  status: string;
  liveUrl: string;
  currentDeployment?: Deployment | null;
  created_at: string;
  updated_at: string;
}

export interface ProjectFile {
  path: string;
  size: number;
}

export interface Build {
  id: string;
  project_id: string;
  framework: string;
  status: "queued" | "running" | "succeeded" | "failed" | "canceled";
  error_code: string | null;
  error_message: string | null;
  artifact_count: number | null;
  artifact_bytes: number | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  reused?: boolean;
}

export interface Deployment {
  deploymentId: string;
  deploymentNumber: number;
  status: string;
  buildId: string;
  isCurrent: boolean;
  deployedAt: string | null;
  assetCount: number;
  totalBytes: number;
  slug: string;
  username: string;
  liveUrl?: string;
  errorMessage?: string | null;
}

export interface Me {
  userId: string;
  username: string;
  displayName: string | null;
  avatarUrl: string | null;
  mcpConnections: number;
}

export interface McpConnection {
  grantId: string;
  clientId: string;
  clientName: string | null;
  scopes: string[];
  createdAt: string;
  lastUsedAt: string | null;
}

export interface ValidationIssue {
  severity: "error" | "warning";
  code: string;
  message: string;
  path?: string;
}

export const api = {
  me: () => request<Me>("GET", "/api/me"),
  usernameAvailable: (username: string) =>
    request<{ username: string; available: boolean; reason?: "invalid" | "reserved" | "taken" }>(
      "GET",
      "/api/username-available",
      undefined,
      { username },
    ),

  listProjects: (status = "active") => request<Project[]>("GET", "/api/projects", undefined, { status }),
  createProject: (input: { name: string; description?: string; framework?: string; slug?: string }) =>
    request<Project>("POST", "/api/projects", input),
  getProject: (ref: string) => request<Project>("GET", `/api/projects/${encodeURIComponent(ref)}`),
  updateProject: (ref: string, input: { name?: string; description?: string | null; update_slug?: boolean; status?: string }) =>
    request<Project>("PATCH", `/api/projects/${encodeURIComponent(ref)}`, input),
  deleteProject: (ref: string, confirmSlug: string) =>
    request<{ deleted: boolean }>("DELETE", `/api/projects/${encodeURIComponent(ref)}`, undefined, { confirm_slug: confirmSlug }),

  listFiles: (ref: string, directory?: string) =>
    request<ProjectFile[]>("GET", `/api/projects/${encodeURIComponent(ref)}/files`, undefined, directory ? { directory } : undefined),
  readFile: (ref: string, path: string) =>
    request<{ path: string; content: string }>("GET", `/api/projects/${encodeURIComponent(ref)}/files/${encodePath(path)}`),
  writeFile: (ref: string, path: string, content: string) =>
    request<{ path: string; size: number }>("PUT", `/api/projects/${encodeURIComponent(ref)}/files/${encodePath(path)}`, { content }),
  deleteFile: (ref: string, path: string) =>
    request<{ deleted: boolean }>("DELETE", `/api/projects/${encodeURIComponent(ref)}/files/${encodePath(path)}`),
  validate: (ref: string) => request<{ valid: boolean; issues: ValidationIssue[] }>("POST", `/api/projects/${encodeURIComponent(ref)}/validate`),

  startBuild: (ref: string, input: { install_dependencies?: boolean } = {}) =>
    request<Build>("POST", `/api/projects/${encodeURIComponent(ref)}/builds`, input),
  listBuilds: (ref: string) => request<Build[]>("GET", `/api/projects/${encodeURIComponent(ref)}/builds`),
  getBuild: (id: string) => request<Build>("GET", `/api/builds/${id}`),
  buildLogs: (id: string, offset = 0, limit = 16000) =>
    request<{ content: string; nextOffset: number; total: number; status: string; logTruncated: boolean }>(
      "GET",
      `/api/builds/${id}/logs`,
      undefined,
      { offset: String(offset), limit: String(limit) },
    ),

  deploy: (ref: string, buildId?: string) =>
    request<Deployment>("POST", `/api/projects/${encodeURIComponent(ref)}/deployments`, buildId ? { build_id: buildId } : {}),
  listDeployments: (ref: string) => request<Deployment[]>("GET", `/api/projects/${encodeURIComponent(ref)}/deployments`),
  rollback: (ref: string, deploymentId: string) =>
    request<Deployment>("POST", `/api/projects/${encodeURIComponent(ref)}/deployments/${deploymentId}/rollback`),
  unpublish: (ref: string) => request<{ unpublished: boolean }>("DELETE", `/api/projects/${encodeURIComponent(ref)}/deployments`),

  listConnections: () => request<McpConnection[]>("GET", "/api/authorizations"),
  revokeConnection: (grantId: string) => request<{ revoked: boolean }>("DELETE", `/api/authorizations/${encodeURIComponent(grantId)}`),
  deleteAccount: () => request<{ deleted: boolean }>("DELETE", "/api/me"),
};

function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}
