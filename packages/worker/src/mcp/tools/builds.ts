/**
 * Build tools: start builds, poll status, read logs.
 */

import { z } from "zod/v4";
import type { McpServer } from "@modelcontextprotocol/server";
import { LIMITS } from "@lemonaide/shared";
import * as repos from "../../db/repos";
import { readBuildLogs, startBuild } from "../../services/builds";
import { requireWriteScope, resolveProject, runTool, type ToolContext } from "./common";

function describeBuild(build: repos.BuildRow): Record<string, unknown> {
  return {
    id: build.id,
    projectId: build.project_id,
    versionId: build.version_id,
    framework: build.framework,
    status: build.status,
    installCommand: build.install_command,
    buildCommand: build.build_command,
    artifactPrefix: build.artifact_prefix,
    artifactCount: build.artifact_count,
    artifactBytes: build.artifact_bytes,
    errorCode: build.error_code,
    errorMessage: build.error_message,
    runnerRunId: build.runner_run_id,
    logTruncated: build.log_truncated,
    createdAt: build.created_at,
    startedAt: build.started_at,
    finishedAt: build.finished_at,
  };
}

export function registerBuildTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "build_project",
    {
      title: "Build project",
      description: `Start an isolated build of the project's current files (${LIMITS.maxBuildsPerDay} builds/day). Poll get_build_status until it succeeds, then deploy_project.`,
      inputSchema: z.object({
        project: z.string().describe("Project URL name (slug) or id"),
        install_dependencies: z
          .boolean()
          .optional()
          .describe("Install package.json dependencies before building (default true)"),
        idempotency_key: z
          .string()
          .max(100)
          .optional()
          .describe("Unique key; re-submitting the same key returns the existing build instead of starting a new one"),
      }),
    },
    async ({ project: ref, install_dependencies, idempotency_key }) =>
      runTool(async () => {
        requireWriteScope(ctx);
        const project = await resolveProject(ctx, ref);
        const { build, reused } = await startBuild(ctx.env, ctx.db, ctx.user, project, {
          installDependencies: install_dependencies,
          idempotencyKey: idempotency_key,
        });
        return {
          ...describeBuild(build),
          reused,
          hint: "poll get_build_status with this build id until status is succeeded or failed",
        };
      }),
  );

  server.registerTool(
    "get_build_status",
    {
      title: "Get build status",
      description: "Get the status of one build, including error details when it failed.",
      inputSchema: z.object({ build_id: z.string() }),
    },
    async ({ build_id }) =>
      runTool(async () => {
        const build = await repos.getBuildForOwner(ctx.db, ctx.user.userId, build_id);
        if (!build) throw new Error(`no build with id ${build_id}`);
        return describeBuild(build);
      }),
  );

  server.registerTool(
    "list_builds",
    {
      title: "List builds",
      description: "List builds for a project, newest first.",
      inputSchema: z.object({
        project: z.string().describe("Project URL name (slug) or id"),
        limit: z.number().int().min(1).max(50).optional(),
      }),
    },
    async ({ project: ref, limit }) =>
      runTool(async () => {
        const project = await resolveProject(ctx, ref);
        const builds = await repos.listBuilds(ctx.db, ctx.user.userId, project.id, limit ?? 20);
        return builds.map(describeBuild);
      }),
  );

  server.registerTool(
    "get_build_logs",
    {
      title: "Get build logs",
      description: "Read a build's log output. Pass offset from a previous response to page forward.",
      inputSchema: z.object({
        build_id: z.string(),
        offset: z.number().int().min(0).optional().describe("Character offset (default 0)"),
        limit: z.number().int().min(1).max(64_000).optional().describe("Max characters to return (default 16000)"),
      }),
    },
    async ({ build_id, offset, limit }) =>
      runTool(async () => {
        const build = await repos.getBuildForOwner(ctx.db, ctx.user.userId, build_id);
        if (!build) throw new Error(`no build with id ${build_id}`);
        const logs = await readBuildLogs(ctx.env, build_id, offset ?? 0, limit ?? 16_000);
        return {
          buildId: build_id,
          status: build.status,
          content: logs.content,
          nextOffset: logs.nextOffset,
          total: logs.total,
          logTruncated: build.log_truncated,
        };
      }),
  );
}
