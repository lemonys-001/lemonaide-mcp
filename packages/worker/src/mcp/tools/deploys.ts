/**
 * Deployment tools: publish, list, roll back, unpublish.
 */

import { z } from "zod/v4";
import type { McpServer } from "@modelcontextprotocol/server";
import { LIMITS } from "@lemonaide/shared";
import * as repos from "../../db/repos";
import { deployProject, rollbackDeployment, unpublishProject, describeDeployment, liveUrlForDeployment } from "../../services/deploys";
import { requireWriteScope, resolveProject, runTool, type ToolContext } from "./common";

export function registerDeployTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "deploy_project",
    {
      title: "Deploy project",
      description: `Publish the latest successful build (or a specific build_id) live at https://…/{username}/{project} (${LIMITS.maxDeploysPerDay} deploys/day).`,
      inputSchema: z.object({
        project: z.string().describe("Project URL name (slug) or id"),
        build_id: z.string().optional().describe("Deploy a specific succeeded build; defaults to the latest"),
      }),
    },
    async ({ project: ref, build_id }) =>
      runTool(async () => {
        requireWriteScope(ctx);
        const project = await resolveProject(ctx, ref);
        const result = await deployProject(ctx.env, ctx.db, ctx.user, project, { buildId: build_id });
        return {
          ...describeDeployment(result.deployment),
          liveUrl: result.liveUrl,
          previousDeploymentId: result.previousId,
        };
      }),
  );

  server.registerTool(
    "list_deployments",
    {
      title: "List deployments",
      description: "List a project's deployments, newest first, marking which one is live.",
      inputSchema: z.object({
        project: z.string().describe("Project URL name (slug) or id"),
        limit: z.number().int().min(1).max(50).optional(),
      }),
    },
    async ({ project: ref, limit }) =>
      runTool(async () => {
        const project = await resolveProject(ctx, ref);
        const deployments = await repos.listDeploymentsForOwner(ctx.db, ctx.user.userId, project.id, limit ?? 20);
        return deployments.map((d) => ({
          ...describeDeployment(d),
          liveUrl: liveUrlForDeployment(ctx.env, d),
        }));
      }),
  );

  server.registerTool(
    "rollback_deployment",
    {
      title: "Roll back deployment",
      description: "Make a previous deployment live again (instant rollback, no rebuild).",
      inputSchema: z.object({
        project: z.string().describe("Project URL name (slug) or id"),
        deployment_id: z.string().describe("The deployment to roll back to"),
      }),
    },
    async ({ project: ref, deployment_id }) =>
      runTool(async () => {
        requireWriteScope(ctx);
        const project = await resolveProject(ctx, ref);
        const result = await rollbackDeployment(ctx.env, ctx.db, ctx.user, project, deployment_id);
        return {
          ...describeDeployment(result.deployment),
          liveUrl: result.liveUrl,
          rolledBackFrom: result.previousId,
        };
      }),
  );

  server.registerTool(
    "unpublish_project",
    {
      title: "Unpublish project",
      description: "Take the live deployment offline. The URL stops serving until the next deploy.",
      inputSchema: z.object({ project: z.string().describe("Project URL name (slug) or id") }),
    },
    async ({ project: ref }) =>
      runTool(async () => {
        requireWriteScope(ctx);
        const project = await resolveProject(ctx, ref);
        await unpublishProject(ctx.db, ctx.user, project);
        return { unpublished: true, project: project.slug, liveUrl: liveUrlForDeployment(ctx.env, { username: ctx.user.username, slug: project.slug }) };
      }),
  );
}
