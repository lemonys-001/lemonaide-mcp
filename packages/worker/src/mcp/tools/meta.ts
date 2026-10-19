/**
 * Account / platform meta tools: quotas, usage, connection management.
 */

import { z } from "zod/v4";
import type { McpServer } from "@modelcontextprotocol/server";
import { FRAMEWORKS, LIMITS } from "@lemonaide/shared";
import * as repos from "../../db/repos";
import { sumSourceBytes } from "../../db/repos";
import { requireWriteScope, runTool, type ToolContext } from "./common";

export function registerMetaTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "get_platform_info",
    {
      title: "Platform info",
      description: "Platform capabilities: supported frameworks, limits, your username, and live URL pattern.",
    },
    async () =>
      runTool(async () => ({
        platform: "LemonAIde",
        username: ctx.user.username,
        frameworks: FRAMEWORKS,
        limits: {
          projectsPerUser: LIMITS.maxProjectsPerUser,
          buildsPerDay: LIMITS.maxBuildsPerDay,
          deploysPerDay: LIMITS.maxDeploysPerDay,
          deploymentsPerProject: LIMITS.maxDeploymentsPerProject,
          fileMaxBytes: LIMITS.projectFileMaxBytes,
          sourceTotalMaxBytes: LIMITS.projectTotalMaxBytes,
          artifactMaxBytes: LIMITS.artifactMaxBytes,
        },
        liveUrlPattern: `https://<platform-domain>/{username}/{project-slug}`,
        scopes: ctx.user.scopes,
      })),
  );

  server.registerTool(
    "get_account_usage",
    {
      title: "Account usage",
      description: "Today's usage against your quotas, plus totals.",
      inputSchema: z.object({}),
    },
    async () =>
      runTool(async () => {
        const [projects, buildsToday, deploysToday, sourceBytes] = await Promise.all([
          repos.countProjects(ctx.db, ctx.user.userId),
          repos.countUsageToday(ctx.db, ctx.user.userId, "build"),
          repos.countUsageToday(ctx.db, ctx.user.userId, "deploy"),
          sumSourceBytes(ctx.db, ctx.user.userId),
        ]);
        return {
          projects: { used: projects, limit: LIMITS.maxProjectsPerUser },
          buildsToday: { used: buildsToday, limit: LIMITS.maxBuildsPerDay },
          deploysToday: { used: deploysToday, limit: LIMITS.maxDeploysPerDay },
          sourceBytes,
        };
      }),
  );

  server.registerTool(
    "list_mcp_connections",
    {
      title: "List MCP connections",
      description: "List the MCP client connections (grants) authorized on this account.",
      inputSchema: z.object({}),
    },
    async () =>
      runTool(async () => {
        const grants = await repos.listMcpAuthorizations(ctx.db, ctx.user.userId);
        return grants.map((g) => ({
          grantId: g.grant_id,
          clientId: g.client_id,
          clientName: g.client_name,
          scopes: g.scopes,
          createdAt: g.granted_at,
          lastUsedAt: g.last_used_at,
        }));
      }),
  );

  server.registerTool(
    "revoke_mcp_connection",
    {
      title: "Revoke MCP connection",
      description:
        "Revoke one MCP client grant by id. Revoking the grant this request uses will end this session immediately.",
      inputSchema: z.object({ grant_id: z.string() }),
    },
    async ({ grant_id }) =>
      runTool(async () => {
        requireWriteScope(ctx);
        const removed = await repos.revokeMcpAuthorization(ctx.db, ctx.user.userId, grant_id);
        if (!removed) throw new Error(`no connection with grant id ${grant_id}`);
        return { revoked: true, grantId: grant_id };
      }),
  );
}
