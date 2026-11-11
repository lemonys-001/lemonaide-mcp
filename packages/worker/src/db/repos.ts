import type { SupabaseClient } from "@supabase/supabase-js";
import type { BuildStatus, DeploymentStatus, Framework } from "@lemonaide/shared";
import { ErrorCode, LemonAIdeError } from "@lemonaide/shared";
import { isUniqueViolation } from "./supabase";

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export interface Project {
  id: string;
  owner_id: string;
  name: string;
  slug: string;
  description: string | null;
  framework: Framework;
  status: "active" | "archived";
  created_at: string;
  updated_at: string;
}

export interface ProjectFileRow {
  project_id: string;
  path: string;
  size: number;
  sha256: string;
  version_id: string | null;
  updated_at: string;
}

export interface ProjectVersion {
  id: string;
  project_id: string;
  version: number;
  label: string | null;
  manifest: { files: { path: string; size: number; sha256: string }[] };
  file_count: number;
  total_bytes: number;
  storage_prefix: string;
  created_at: string;
}

export interface BuildRow {
  id: string;
  project_id: string;
  version_id: string | null;
  status: BuildStatus;
  framework: Framework;
  install_command: string | null;
  build_command: string | null;
  idempotency_key: string | null;
  runner_run_id: number | null;
  artifact_prefix: string | null;
  artifact_count: number | null;
  artifact_bytes: number | null;
  error_code: string | null;
  error_message: string | null;
  log_truncated: boolean;
  correlation_id: string;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export interface DeploymentRow {
  id: string;
  project_id: string;
  build_id: string;
  deployment_number: number;
  status: DeploymentStatus;
  slug: string;
  username: string;
  asset_prefix: string;
  asset_count: number;
  total_bytes: number;
  commit_sha: string | null;
  is_current: boolean;
  error_message: string | null;
  created_at: string;
  deployed_at: string | null;
}

export interface GithubInstallation {
  id: string;
  user_id: string;
  installation_id: number;
  account_login: string;
  account_type: string;
  suspended_at: string | null;
}

export interface GithubRepository {
  id: string;
  project_id: string;
  /** Null in token (PAT) mode — no GitHub App installation exists. */
  installation_id: number | null;
  repo_full_name: string;
  repo_url: string;
  default_branch: string;
  is_private: boolean;
  last_commit_sha: string | null;
  last_synced_at: string | null;
}

export interface McpAuthorizationRow {
  id: string;
  user_id: string;
  client_id: string;
  client_name: string | null;
  scopes: string[];
  grant_id: string;
  granted_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

/* ------------------------------------------------------------------ */
/* Projects (owner-scoped)                                             */
/* ------------------------------------------------------------------ */

export async function listProjects(
  db: SupabaseClient,
  ownerId: string,
  opts: { status?: "active" | "archived" | "all"; limit?: number } = {},
): Promise<Project[]> {
  let q = db.from("projects").select("*").eq("owner_id", ownerId);
  if (opts.status && opts.status !== "all") q = q.eq("status", opts.status);
  const { data, error } = await q.order("created_at", { ascending: false }).limit(opts.limit ?? 50);
  if (error) throw new LemonAIdeError(ErrorCode.INTERNAL, "failed to list projects", { cause: error });
  return (data ?? []) as Project[];
}

export async function getProject(
  db: SupabaseClient,
  ownerId: string,
  projectId: string,
): Promise<Project | null> {
  const { data, error } = await db
    .from("projects")
    .select("*")
    .eq("id", projectId)
    .eq("owner_id", ownerId)
    .maybeSingle();
  if (error) throw new LemonAIdeError(ErrorCode.INTERNAL, "failed to load project", { cause: error });
  return (data as Project | null) ?? null;
}

export async function getProjectBySlug(
  db: SupabaseClient,
  ownerId: string,
  slug: string,
): Promise<Project | null> {
  const { data, error } = await db
    .from("projects")
    .select("*")
    .eq("slug", slug)
    .eq("owner_id", ownerId)
    .maybeSingle();
  if (error) throw new LemonAIdeError(ErrorCode.INTERNAL, "failed to load project", { cause: error });
  return (data as Project | null) ?? null;
}

export async function requireProject(
  db: SupabaseClient,
  ownerId: string,
  projectId: string,
): Promise<Project> {
  const project = await getProject(db, ownerId, projectId);
  if (!project) throw new LemonAIdeError(ErrorCode.NOT_FOUND, "project not found");
  return project;
}

export async function countProjects(db: SupabaseClient, ownerId: string): Promise<number> {
  const { count, error } = await db
    .from("projects")
    .select("id", { count: "exact", head: true })
    .eq("owner_id", ownerId);
  if (error) throw new LemonAIdeError(ErrorCode.INTERNAL, "failed to count projects", { cause: error });
  return count ?? 0;
}

export async function insertProject(
  db: SupabaseClient,
  input: { ownerId: string; name: string; slug: string; description?: string; framework: Framework },
): Promise<Project> {
  const { data, error } = await db
    .from("projects")
    .insert({
      owner_id: input.ownerId,
      name: input.name,
      slug: input.slug,
      description: input.description ?? null,
      framework: input.framework,
    })
    .select("*")
    .single();
  if (error) {
    if (isUniqueViolation(error)) {
      throw new LemonAIdeError(ErrorCode.ALREADY_EXISTS, "a project with this URL name already exists");
    }
    throw new LemonAIdeError(ErrorCode.INTERNAL, "failed to create project", { cause: error });
  }
  return data as Project;
}

export async function updateProject(
  db: SupabaseClient,
  ownerId: string,
  projectId: string,
  patch: Partial<Pick<Project, "name" | "slug" | "description" | "status">>,
): Promise<Project> {
  const { data, error } = await db
    .from("projects")
    .update(patch)
    .eq("id", projectId)
    .eq("owner_id", ownerId)
    .select("*")
    .single();
  if (error) {
    if (isUniqueViolation(error)) {
      throw new LemonAIdeError(ErrorCode.ALREADY_EXISTS, "a project with this URL name already exists");
    }
    if (error.code === "PGRST116") throw new LemonAIdeError(ErrorCode.NOT_FOUND, "project not found");
    throw new LemonAIdeError(ErrorCode.INTERNAL, "failed to update project", { cause: error });
  }
  return data as Project;
}

export async function deleteProject(db: SupabaseClient, ownerId: string, projectId: string): Promise<void> {
  const { data, error } = await db
    .from("projects")
    .delete()
    .eq("id", projectId)
    .eq("owner_id", ownerId)
    .select("id");
  if (error) throw new LemonAIdeError(ErrorCode.INTERNAL, "failed to delete project", { cause: error });
  if (!data || data.length === 0) throw new LemonAIdeError(ErrorCode.NOT_FOUND, "project not found");
}

/* ------------------------------------------------------------------ */
/* File index (current state; bytes live in R2)                        */
/* ------------------------------------------------------------------ */

export async function listFileRows(db: SupabaseClient, projectId: string): Promise<ProjectFileRow[]> {
  const { data, error } = await db
    .from("project_files")
    .select("*")
    .eq("project_id", projectId)
    .order("path");
  if (error) throw new LemonAIdeError(ErrorCode.INTERNAL, "failed to list files", { cause: error });
  return (data ?? []) as ProjectFileRow[];
}

export async function upsertFileRows(
  db: SupabaseClient,
  projectId: string,
  files: { path: string; size: number; sha256: string; versionId?: string | null }[],
): Promise<void> {
  if (files.length === 0) return;
  const { error } = await db.from("project_files").upsert(
    files.map((f) => ({
      project_id: projectId,
      path: f.path,
      size: f.size,
      sha256: f.sha256,
      version_id: f.versionId ?? null,
      updated_at: new Date().toISOString(),
    })),
    { onConflict: "project_id,path" },
  );
  if (error) throw new LemonAIdeError(ErrorCode.INTERNAL, "failed to record files", { cause: error });
}

export async function deleteFileRow(db: SupabaseClient, projectId: string, path: string): Promise<boolean> {
  const { data, error } = await db
    .from("project_files")
    .delete()
    .eq("project_id", projectId)
    .eq("path", path)
    .select("path");
  if (error) throw new LemonAIdeError(ErrorCode.INTERNAL, "failed to delete file record", { cause: error });
  return (data?.length ?? 0) > 0;
}

/* ------------------------------------------------------------------ */
/* Versions (snapshots)                                                */
/* ------------------------------------------------------------------ */

export async function nextProjectVersion(db: SupabaseClient, projectId: string): Promise<number> {
  const { data, error } = await db
    .from("project_versions")
    .select("version")
    .eq("project_id", projectId)
    .order("version", { ascending: false })
    .limit(1);
  if (error) throw new LemonAIdeError(ErrorCode.INTERNAL, "failed to read versions", { cause: error });
  const current = (data?.[0] as { version: number } | undefined)?.version ?? 0;
  return current + 1;
}

export async function insertProjectVersion(
  db: SupabaseClient,
  input: {
    projectId: string;
    version: number;
    label?: string;
    manifest: ProjectVersion["manifest"];
    fileCount: number;
    totalBytes: number;
    storagePrefix: string;
    createdBy?: string;
  },
): Promise<ProjectVersion> {
  const { data, error } = await db
    .from("project_versions")
    .insert({
      project_id: input.projectId,
      version: input.version,
      label: input.label ?? null,
      manifest: input.manifest,
      file_count: input.fileCount,
      total_bytes: input.totalBytes,
      storage_prefix: input.storagePrefix,
      created_by: input.createdBy ?? null,
    })
    .select("*")
    .single();
  if (error) throw new LemonAIdeError(ErrorCode.INTERNAL, "failed to create snapshot", { cause: error });
  return data as ProjectVersion;
}

export async function listProjectVersions(db: SupabaseClient, projectId: string, limit = 20): Promise<ProjectVersion[]> {
  const { data, error } = await db
    .from("project_versions")
    .select("*")
    .eq("project_id", projectId)
    .order("version", { ascending: false })
    .limit(limit);
  if (error) throw new LemonAIdeError(ErrorCode.INTERNAL, "failed to list snapshots", { cause: error });
  return (data ?? []) as ProjectVersion[];
}

export async function getProjectVersion(
  db: SupabaseClient,
  projectId: string,
  version: number,
): Promise<ProjectVersion | null> {
  const { data, error } = await db
    .from("project_versions")
    .select("*")
    .eq("project_id", projectId)
    .eq("version", version)
    .maybeSingle();
  if (error) throw new LemonAIdeError(ErrorCode.INTERNAL, "failed to load snapshot", { cause: error });
  return (data as ProjectVersion | null) ?? null;
}

/* ------------------------------------------------------------------ */
/* Builds                                                              */
/* ------------------------------------------------------------------ */

export async function insertBuild(
  db: SupabaseClient,
  input: {
    projectId: string;
    versionId?: string | null;
    framework: Framework;
    installCommand: string | null;
    buildCommand: string | null;
    idempotencyKey?: string;
  },
): Promise<BuildRow> {
  const { data, error } = await db
    .from("builds")
    .insert({
      project_id: input.projectId,
      version_id: input.versionId ?? null,
      framework: input.framework,
      install_command: input.installCommand,
      build_command: input.buildCommand,
      idempotency_key: input.idempotencyKey ?? null,
      status: "queued",
    })
    .select("*")
    .single();
  if (error) {
    if (isUniqueViolation(error)) {
      const existing = await findByIdempotencyKey(db, input.idempotencyKey!);
      if (existing) return existing;
    }
    throw new LemonAIdeError(ErrorCode.INTERNAL, "failed to create build", { cause: error });
  }
  return data as BuildRow;
}

export async function findByIdempotencyKey(db: SupabaseClient, key: string): Promise<BuildRow | null> {
  const { data, error } = await db.from("builds").select("*").eq("idempotency_key", key).maybeSingle();
  if (error) throw new LemonAIdeError(ErrorCode.INTERNAL, "failed to look up build", { cause: error });
  return (data as BuildRow | null) ?? null;
}

export async function getBuild(db: SupabaseClient, buildId: string): Promise<BuildRow | null> {
  const { data, error } = await db.from("builds").select("*").eq("id", buildId).maybeSingle();
  if (error) throw new LemonAIdeError(ErrorCode.INTERNAL, "failed to load build", { cause: error });
  return (data as BuildRow | null) ?? null;
}

/** Owner-checked variant: build must belong to one of the owner's projects. */
export async function getBuildForOwner(
  db: SupabaseClient,
  ownerId: string,
  buildId: string,
): Promise<BuildRow | null> {
  const { data, error } = await db
    .from("builds")
    .select("*, projects!inner(owner_id, slug, name, framework)")
    .eq("id", buildId)
    .eq("projects.owner_id", ownerId)
    .maybeSingle();
  if (error) throw new LemonAIdeError(ErrorCode.INTERNAL, "failed to load build", { cause: error });
  if (!data) return null;
  const { projects: _project, ...build } = data as BuildRow & { projects: unknown };
  return build as BuildRow;
}

export async function updateBuild(
  db: SupabaseClient,
  buildId: string,
  patch: Partial<{
    status: BuildStatus;
    version_id: string | null;
    runner_run_id: number | null;
    artifact_prefix: string | null;
    artifact_count: number | null;
    artifact_bytes: number | null;
    error_code: string | null;
    error_message: string | null;
    log_truncated: boolean;
    started_at: string | null;
    finished_at: string | null;
  }>,
): Promise<void> {
  const { error } = await db.from("builds").update(patch).eq("id", buildId);
  if (error) throw new LemonAIdeError(ErrorCode.INTERNAL, "failed to update build", { cause: error });
}

export async function listBuilds(
  db: SupabaseClient,
  ownerId: string,
  projectId: string,
  limit = 20,
): Promise<BuildRow[]> {
  const { data, error } = await db
    .from("builds")
    .select("*, projects!inner(owner_id)")
    .eq("project_id", projectId)
    .eq("projects.owner_id", ownerId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw new LemonAIdeError(ErrorCode.INTERNAL, "failed to list builds", { cause: error });
  return ((data ?? []) as (BuildRow & { projects: unknown })[]).map(({ projects: _p, ...b }) => b as BuildRow);
}

/* ------------------------------------------------------------------ */
/* Deployments                                                         */
/* ------------------------------------------------------------------ */

export async function insertDeployment(
  db: SupabaseClient,
  input: {
    projectId: string;
    buildId: string;
    deploymentNumber: number;
    slug: string;
    username: string;
    assetPrefix: string;
    assetCount: number;
    totalBytes: number;
  },
): Promise<DeploymentRow> {
  const { data, error } = await db
    .from("deployments")
    .insert({
      project_id: input.projectId,
      build_id: input.buildId,
      deployment_number: input.deploymentNumber,
      slug: input.slug,
      username: input.username,
      asset_prefix: input.assetPrefix,
      asset_count: input.assetCount,
      total_bytes: input.totalBytes,
      status: "pending",
    })
    .select("*")
    .single();
  if (error) throw new LemonAIdeError(ErrorCode.INTERNAL, "failed to create deployment", { cause: error });
  return data as DeploymentRow;
}

export async function updateDeployment(
  db: SupabaseClient,
  deploymentId: string,
  patch: Partial<{
    status: DeploymentStatus;
    deployed_at: string | null;
    error_message: string | null;
    commit_sha: string | null;
    asset_prefix: string;
    slug: string;
    username: string;
    asset_count: number;
    total_bytes: number;
  }>,
): Promise<void> {
  const { error } = await db.from("deployments").update(patch).eq("id", deploymentId);
  if (error) throw new LemonAIdeError(ErrorCode.INTERNAL, "failed to update deployment", { cause: error });
}

export async function getDeploymentForOwner(
  db: SupabaseClient,
  ownerId: string,
  deploymentId: string,
): Promise<DeploymentRow | null> {
  const { data, error } = await db
    .from("deployments")
    .select("*, projects!inner(owner_id)")
    .eq("id", deploymentId)
    .eq("projects.owner_id", ownerId)
    .maybeSingle();
  if (error) throw new LemonAIdeError(ErrorCode.INTERNAL, "failed to load deployment", { cause: error });
  if (!data) return null;
  const { projects: _p, ...rest } = data as DeploymentRow & { projects: unknown };
  return rest as DeploymentRow;
}

export async function listDeploymentsForOwner(
  db: SupabaseClient,
  ownerId: string,
  projectId: string,
  limit = 20,
): Promise<DeploymentRow[]> {
  const { data, error } = await db
    .from("deployments")
    .select("*, projects!inner(owner_id)")
    .eq("project_id", projectId)
    .eq("projects.owner_id", ownerId)
    .order("deployment_number", { ascending: false })
    .limit(limit);
  if (error) throw new LemonAIdeError(ErrorCode.INTERNAL, "failed to list deployments", { cause: error });
  return ((data ?? []) as (DeploymentRow & { projects: unknown })[]).map(
    ({ projects: _p, ...d }) => d as DeploymentRow,
  );
}

export async function getCurrentDeploymentByProject(
  db: SupabaseClient,
  projectId: string,
): Promise<DeploymentRow | null> {
  const { data, error } = await db
    .from("deployments")
    .select("*")
    .eq("project_id", projectId)
    .eq("is_current", true)
    .maybeSingle();
  if (error) throw new LemonAIdeError(ErrorCode.INTERNAL, "failed to load current deployment", { cause: error });
  return (data as DeploymentRow | null) ?? null;
}

/** Current deployment per project, for the dashboard project list. */
export async function listCurrentDeployments(
  db: SupabaseClient,
  projectIds: string[],
): Promise<Map<string, DeploymentRow>> {
  if (projectIds.length === 0) return new Map();
  const { data, error } = await db
    .from("deployments")
    .select("*")
    .in("project_id", projectIds)
    .eq("is_current", true);
  if (error) throw new LemonAIdeError(ErrorCode.INTERNAL, "failed to load current deployments", { cause: error });
  const map = new Map<string, DeploymentRow>();
  for (const row of (data ?? []) as DeploymentRow[]) map.set(row.project_id, row);
  return map;
}

/** Public lookup used by the domain router: (username, slug) → current deployment. */
export async function lookupLiveDeployment(
  db: SupabaseClient,
  username: string,
  slug: string,
): Promise<{ deployment: DeploymentRow; projectName: string } | null> {
  const { data, error } = await db
    .from("deployments")
    .select("*, projects!inner(name, owner_id, status)")
    .eq("username", username)
    .eq("slug", slug)
    .eq("is_current", true)
    .eq("status", "deployed")
    .eq("projects.status", "active")
    .maybeSingle();
  if (error) throw new LemonAIdeError(ErrorCode.INTERNAL, "deployment lookup failed", { cause: error });
  if (!data) return null;
  const { projects, ...deployment } = data as DeploymentRow & { projects: { name: string } };
  return { deployment: deployment as DeploymentRow, projectName: projects.name };
}

/**
 * Atomically promote a deployment to current (superseding the previous one)
 * via the set_current_deployment() Postgres function (see migration 0002).
 */
export async function promoteDeployment(
  db: SupabaseClient,
  deploymentId: string,
  ownerId: string,
): Promise<void> {
  const { error } = await db.rpc("set_current_deployment", {
    p_deployment_id: deploymentId,
    p_owner: ownerId,
  });
  if (error) {
    if (error.message?.includes("not found")) {
      throw new LemonAIdeError(ErrorCode.NOT_FOUND, "deployment not found");
    }
    if (error.message?.includes("not in")) {
      throw new LemonAIdeError(ErrorCode.DEPLOY_INVALID_STATE, error.message);
    }
    throw new LemonAIdeError(ErrorCode.INTERNAL, "failed to promote deployment", { cause: error });
  }
}

export async function clearCurrentDeployment(
  db: SupabaseClient,
  projectId: string,
  ownerId: string,
): Promise<void> {
  const { error } = await db.rpc("clear_current_deployment", {
    p_project_id: projectId,
    p_owner: ownerId,
  });
  if (error) throw new LemonAIdeError(ErrorCode.INTERNAL, "failed to unpublish deployment", { cause: error });
}

/* ------------------------------------------------------------------ */
/* GitHub                                                              */
/* ------------------------------------------------------------------ */

export async function getGithubInstallation(db: SupabaseClient, userId: string): Promise<GithubInstallation | null> {
  const { data, error } = await db
    .from("github_installations")
    .select("*")
    .eq("user_id", userId)
    .is("suspended_at", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new LemonAIdeError(ErrorCode.INTERNAL, "failed to load GitHub installation", { cause: error });
  return (data as GithubInstallation | null) ?? null;
}

export async function upsertGithubInstallation(
  db: SupabaseClient,
  input: {
    userId: string;
    installationId: number;
    accountLogin: string;
    accountType: string;
    permissions?: Record<string, string>;
  },
): Promise<GithubInstallation> {
  const { data, error } = await db
    .from("github_installations")
    .upsert(
      {
        user_id: input.userId,
        installation_id: input.installationId,
        account_login: input.accountLogin,
        account_type: input.accountType,
        permissions: input.permissions ?? {},
        suspended_at: null,
      },
      { onConflict: "installation_id" },
    )
    .select("*")
    .single();
  if (error) throw new LemonAIdeError(ErrorCode.INTERNAL, "failed to save GitHub installation", { cause: error });
  return data as GithubInstallation;
}

export async function setGithubInstallationSuspended(
  db: SupabaseClient,
  installationId: number,
  suspended: boolean,
): Promise<void> {
  const { error } = await db
    .from("github_installations")
    .update({ suspended_at: suspended ? new Date().toISOString() : null })
    .eq("installation_id", installationId);
  if (error) throw new LemonAIdeError(ErrorCode.INTERNAL, "failed to update installation status", { cause: error });
}

export async function deleteGithubInstallation(db: SupabaseClient, installationId: number): Promise<void> {
  const { error } = await db.from("github_installations").delete().eq("installation_id", installationId);
  if (error) throw new LemonAIdeError(ErrorCode.INTERNAL, "failed to remove installation", { cause: error });
}

export async function getGithubRepository(db: SupabaseClient, projectId: string): Promise<GithubRepository | null> {
  const { data, error } = await db
    .from("github_repositories")
    .select("*")
    .eq("project_id", projectId)
    .maybeSingle();
  if (error) throw new LemonAIdeError(ErrorCode.INTERNAL, "failed to load repository", { cause: error });
  return (data as GithubRepository | null) ?? null;
}

export async function upsertGithubRepository(
  db: SupabaseClient,
  input: {
    projectId: string;
    installationId: number | null;
    repoFullName: string;
    repoUrl: string;
    defaultBranch?: string;
    isPrivate: boolean;
    lastCommitSha?: string | null;
  },
): Promise<GithubRepository> {
  const { data, error } = await db
    .from("github_repositories")
    .upsert(
      {
        project_id: input.projectId,
        installation_id: input.installationId,
        repo_full_name: input.repoFullName,
        repo_url: input.repoUrl,
        default_branch: input.defaultBranch ?? "main",
        is_private: input.isPrivate,
        last_commit_sha: input.lastCommitSha ?? null,
        last_synced_at: new Date().toISOString(),
      },
      { onConflict: "project_id" },
    )
    .select("*")
    .single();
  if (error) throw new LemonAIdeError(ErrorCode.INTERNAL, "failed to save repository", { cause: error });
  return data as GithubRepository;
}

export async function deleteGithubRepository(db: SupabaseClient, projectId: string): Promise<boolean> {
  const { data, error } = await db
    .from("github_repositories")
    .delete()
    .eq("project_id", projectId)
    .select("id");
  if (error) throw new LemonAIdeError(ErrorCode.INTERNAL, "failed to remove repository link", { cause: error });
  return (data ?? []).length > 0;
}

export async function updateGithubLastSync(
  db: SupabaseClient,
  projectId: string,
  commitSha: string,
): Promise<void> {
  const { error } = await db
    .from("github_repositories")
    .update({ last_commit_sha: commitSha, last_synced_at: new Date().toISOString() })
    .eq("project_id", projectId);
  if (error) throw new LemonAIdeError(ErrorCode.INTERNAL, "failed to update sync state", { cause: error });
}

/* ------------------------------------------------------------------ */
/* MCP authorizations                                                  */
/* ------------------------------------------------------------------ */

export async function insertMcpAuthorization(
  db: SupabaseClient,
  input: { userId: string; clientId: string; clientName?: string; scopes: string[]; grantId: string; tokenPrefix?: string; expiresAt?: string },
): Promise<void> {
  const { error } = await db.from("mcp_authorizations").upsert(
    {
      user_id: input.userId,
      client_id: input.clientId,
      client_name: input.clientName ?? null,
      scopes: input.scopes,
      grant_id: input.grantId,
      token_prefix: input.tokenPrefix ?? null,
      granted_at: new Date().toISOString(),
      revoked_at: null,
      expires_at: input.expiresAt ?? null,
    },
    { onConflict: "user_id,grant_id" },
  );
  if (error) throw new LemonAIdeError(ErrorCode.INTERNAL, "failed to record MCP authorization", { cause: error });
}

export async function listMcpAuthorizations(db: SupabaseClient, userId: string): Promise<McpAuthorizationRow[]> {
  const { data, error } = await db
    .from("mcp_authorizations")
    .select("*")
    .eq("user_id", userId)
    .is("revoked_at", null)
    .order("granted_at", { ascending: false });
  if (error) throw new LemonAIdeError(ErrorCode.INTERNAL, "failed to list MCP authorizations", { cause: error });
  return (data ?? []) as McpAuthorizationRow[];
}

export async function revokeMcpAuthorization(db: SupabaseClient, userId: string, grantId: string): Promise<boolean> {
  const { data, error } = await db
    .from("mcp_authorizations")
    .update({ revoked_at: new Date().toISOString() })
    .eq("grant_id", grantId)
    .eq("user_id", userId)
    .is("revoked_at", null)
    .select("id, grant_id");
  if (error) throw new LemonAIdeError(ErrorCode.INTERNAL, "failed to revoke MCP authorization", { cause: error });
  return (data?.length ?? 0) > 0;
}

export async function touchMcpAuthorization(db: SupabaseClient, userId: string, grantId: string): Promise<void> {
  await db.from("mcp_authorizations").update({ last_used_at: new Date().toISOString() }).eq("user_id", userId).eq("grant_id", grantId);
}

/* ------------------------------------------------------------------ */
/* Usage & quotas                                                      */
/* ------------------------------------------------------------------ */

export async function countUsageToday(
  db: SupabaseClient,
  userId: string,
  kind: "build" | "deploy",
): Promise<number> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { count, error } = await db
    .from("usage_records")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .eq("kind", kind)
    .gte("created_at", since);
  if (error) throw new LemonAIdeError(ErrorCode.INTERNAL, "failed to read usage", { cause: error });
  return count ?? 0;
}

export async function recordUsage(
  db: SupabaseClient,
  input: { userId: string; projectId?: string; kind: "build" | "deploy" | "storage" | "project"; quantity?: number; unit?: "count" | "bytes"; meta?: Record<string, unknown> },
): Promise<void> {
  const { error } = await db.from("usage_records").insert({
    user_id: input.userId,
    project_id: input.projectId ?? null,
    kind: input.kind,
    quantity: input.quantity ?? 1,
    unit: input.unit ?? "count",
    meta: input.meta ?? {},
  });
  if (error) throw new LemonAIdeError(ErrorCode.INTERNAL, "failed to record usage", { cause: error });
}

export async function sumSourceBytes(db: SupabaseClient, ownerId: string): Promise<number> {
  const { data, error } = await db
    .from("project_files")
    .select("size, projects!inner(owner_id)")
    .eq("projects.owner_id", ownerId);
  if (error) throw new LemonAIdeError(ErrorCode.INTERNAL, "failed to sum storage", { cause: error });
  return ((data ?? []) as { size: number }[]).reduce((acc, row) => acc + Number(row.size ?? 0), 0);
}
