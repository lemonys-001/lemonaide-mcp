/**
 * Deployment services: promote a built project to live, roll back to a
 * previous deployment, and unpublish. Promotion is atomic via the
 * set_current_deployment / clear_current_deployment Postgres functions
 * (migration 0002); R2 reads always go through the promoted prefix.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { ErrorCode, LIMITS, LemonAIdeError } from "@lemonaide/shared";
import type { Env } from "../env";
import * as repos from "../db/repos";
import { recordAudit, recordUsageSafe } from "../db/usage-audit";
import { validateBuildOutput } from "./builds";
import { liveUrlFor, type Actor } from "./projects";

export function liveUrlForDeployment(env: Env, deployment: { username: string; slug: string }): string {
  return liveUrlFor(env, deployment.username, deployment.slug);
}

export interface DeployResult {
  deployment: repos.DeploymentRow;
  liveUrl: string;
  previousId: string | null;
}

async function pickBuild(
  db: SupabaseClient,
  actor: Actor,
  project: repos.Project,
  buildId: string | undefined,
): Promise<repos.BuildRow> {
  if (buildId) {
    const build = await repos.getBuildForOwner(db, actor.userId, buildId);
    if (!build || build.project_id !== project.id) {
      throw new LemonAIdeError(ErrorCode.NOT_FOUND, "build not found in this project");
    }
    if (build.status !== "succeeded") {
      throw new LemonAIdeError(ErrorCode.BUILD_INVALID_STATE, `build is ${build.status}, only succeeded builds can deploy`);
    }
    return build;
  }

  const { data, error } = await db
    .from("builds")
    .select("*")
    .eq("project_id", project.id)
    .eq("status", "succeeded")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new LemonAIdeError(ErrorCode.INTERNAL, "failed to load latest build", { cause: error });
  if (!data) throw new LemonAIdeError(ErrorCode.BUILD_INVALID_STATE, "no successful build to deploy — run build_project first");
  return data as repos.BuildRow;
}

export async function deployProject(
  env: Env,
  db: SupabaseClient,
  actor: Actor,
  project: repos.Project,
  opts: { buildId?: string } = {},
): Promise<DeployResult> {
  const build = await pickBuild(db, actor, project, opts.buildId);

  // Quotas.
  const deploysToday = await repos.countUsageToday(db, actor.userId, "deploy");
  if (deploysToday >= LIMITS.maxDeploysPerDay) {
    throw new LemonAIdeError(ErrorCode.QUOTA_EXCEEDED, `daily deploy limit reached (${LIMITS.maxDeploysPerDay})`, {
      retryable: true,
    });
  }
  const deployCount = await repos.listDeploymentsForOwner(db, actor.userId, project.id, 1);
  const totalDeployments = deployCount[0]?.deployment_number ?? 0;
  if (totalDeployments >= LIMITS.maxDeploymentsPerProject) {
    throw new LemonAIdeError(ErrorCode.QUOTA_EXCEEDED, `deployment history limit reached (${LIMITS.maxDeploymentsPerProject})`);
  }

  // Fail loudly before any state changes.
  await validateBuildOutput(env, build);

  const previous = await repos.getCurrentDeploymentByProject(db, project.id);

  // deployment_number: next integer, retrying on the unique-constraint race.
  let deployment: repos.DeploymentRow | null = null;
  for (let attempt = 0; attempt < 5 && !deployment; attempt++) {
    const { data: maxRow } = await db
      .from("deployments")
      .select("deployment_number")
      .eq("project_id", project.id)
      .order("deployment_number", { ascending: false })
      .limit(1)
      .maybeSingle();
    const nextNumber = (maxRow?.deployment_number ?? 0) + 1;
    try {
      deployment = await repos.insertDeployment(db, {
        projectId: project.id,
        buildId: build.id,
        deploymentNumber: nextNumber,
        slug: project.slug,
        username: actor.username,
        assetPrefix: build.artifact_prefix as string,
        assetCount: build.artifact_count ?? 0,
        totalBytes: build.artifact_bytes ?? 0,
      });
    } catch {
      // deployment_number race (unique constraint) — retry with a fresh number
    }
  }
  if (!deployment) {
    throw new LemonAIdeError(ErrorCode.CONFLICT, "could not allocate a deployment number", { retryable: true });
  }

  // promote_deployment accepts pending/deployed only — the RPC flips the
  // status to 'deployed' itself, so keep the row at its initial 'pending'.
  try {
    await repos.promoteDeployment(db, deployment.id, actor.userId);
    await repos.updateDeployment(db, deployment.id, {
      status: "deployed",
      deployed_at: new Date().toISOString(),
    });
  } catch (err) {
    await repos.updateDeployment(db, deployment.id, {
      status: "failed",
      error_message: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }

  await recordUsageSafe(db, { userId: actor.userId, projectId: project.id, kind: "deploy" });
  await recordUsageSafe(db, {
    userId: actor.userId,
    projectId: project.id,
    kind: "storage",
    quantity: build.artifact_bytes ?? 0,
    unit: "bytes",
  });
  await recordAudit(db, {
    userId: actor.userId,
    actorType: actor.via,
    action: "deploy.promote",
    targetType: "deployment",
    targetId: deployment.id,
    meta: {
      projectId: project.id,
      buildId: build.id,
      deploymentNumber: deployment.deployment_number,
      previousDeploymentId: previous?.id ?? null,
      liveUrl: liveUrlFor(env, deployment.username, deployment.slug),
    },
  });

  return {
    deployment: { ...deployment, status: "deployed", is_current: true, deployed_at: new Date().toISOString() },
    liveUrl: liveUrlFor(env, deployment.username, deployment.slug),
    previousId: previous?.id ?? null,
  };
}

export async function rollbackDeployment(
  env: Env,
  db: SupabaseClient,
  actor: Actor,
  project: repos.Project,
  deploymentId: string,
): Promise<DeployResult> {
  const target = await repos.getDeploymentForOwner(db, actor.userId, deploymentId);
  if (!target || target.project_id !== project.id) {
    throw new LemonAIdeError(ErrorCode.NOT_FOUND, "deployment not found in this project");
  }
  if (target.status === "deployed" && target.is_current) {
    throw new LemonAIdeError(ErrorCode.DEPLOY_INVALID_STATE, "that deployment is already live");
  }
  if (target.status !== "superseded" && !(target.status === "deployed" && !target.is_current)) {
    throw new LemonAIdeError(ErrorCode.DEPLOY_INVALID_STATE, `deployment is ${target.status}; only superseded deployments can be rolled back to`);
  }

  const build = await repos.getBuildForOwner(db, actor.userId, target.build_id);
  if (!build) throw new LemonAIdeError(ErrorCode.DEPLOY_FAILED, "the build for that deployment no longer exists");
  await validateBuildOutput(env, build);

  const previous = await repos.getCurrentDeploymentByProject(db, project.id);

  await repos.promoteDeployment(db, target.id, actor.userId);
  await repos.updateDeployment(db, target.id, {
    status: "deployed",
    deployed_at: new Date().toISOString(),
    error_message: null,
  });

  await recordUsageSafe(db, { userId: actor.userId, projectId: project.id, kind: "deploy" });
  await recordAudit(db, {
    userId: actor.userId,
    actorType: actor.via,
    action: "deploy.rollback",
    targetType: "deployment",
    targetId: target.id,
    meta: { projectId: project.id, previousDeploymentId: previous?.id ?? null },
  });

  return {
    deployment: { ...target, status: "deployed", is_current: true },
    liveUrl: liveUrlFor(env, target.username, target.slug),
    previousId: previous?.id ?? null,
  };
}

export async function unpublishProject(
  db: SupabaseClient,
  actor: Actor,
  project: repos.Project,
): Promise<void> {
  const current = await repos.getCurrentDeploymentByProject(db, project.id);
  if (!current) throw new LemonAIdeError(ErrorCode.DEPLOY_INVALID_STATE, "project is not published");
  await repos.clearCurrentDeployment(db, project.id, actor.userId);
  await recordAudit(db, {
    userId: actor.userId,
    actorType: actor.via,
    action: "deploy.unpublish",
    targetType: "deployment",
    targetId: current.id,
    meta: { projectId: project.id },
  });
}

export function describeDeployment(deployment: repos.DeploymentRow): Record<string, unknown> {
  return {
    deploymentId: deployment.id,
    deploymentNumber: deployment.deployment_number,
    status: deployment.status,
    buildId: deployment.build_id,
    isCurrent: deployment.is_current,
    deployedAt: deployment.deployed_at,
    assetPrefix: deployment.asset_prefix,
    assetCount: deployment.asset_count,
    totalBytes: deployment.total_bytes,
    slug: deployment.slug,
    username: deployment.username,
    errorMessage: deployment.error_message,
  };
}
