/**
 * GitHub integration tools: connect status, per-project repo creation,
 * and source sync.
 */

import { z } from "zod/v4";
import type { McpServer } from "@modelcontextprotocol/server";
import * as repos from "../../db/repos";
import {
  connectUrl,
  createRepoForProject,
  disconnectRepo,
  syncProjectToGitHub,
} from "../../services/github";
import { requireWriteScope, resolveProject, runTool, type ToolContext } from "./common";

export function registerGithubTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "github_status",
    {
      title: "GitHub connection status",
      description: "Show whether a GitHub App installation is connected, and this project's repository link if any.",
      inputSchema: z.object({ project: z.string().optional().describe("Optional project to also check repo linkage") }),
    },
    async ({ project: ref }) =>
      runTool(async () => {
        const installation = await repos.getGithubInstallation(ctx.db, ctx.user.userId);
        const result: Record<string, unknown> = {
          connected: Boolean(installation),
          installation: installation
            ? { account: installation.account_login, accountType: installation.account_type, installationId: installation.installation_id }
            : null,
        };
        if (ref) {
          const project = await resolveProject(ctx, ref);
          const repo = await repos.getGithubRepository(ctx.db, project.id);
          result.project = project.slug;
          result.repository = repo
            ? {
                fullName: repo.repo_full_name,
                url: repo.repo_url,
                defaultBranch: repo.default_branch,
                lastCommitSha: repo.last_commit_sha,
                lastSyncedAt: repo.last_synced_at,
              }
            : null;
        }
        if (!installation) result.connectUrl = connectUrl(ctx.env);
        return result;
      }),
  );

  server.registerTool(
    "github_create_repo",
    {
      title: "Create GitHub repository",
      description: "Create a repository on the connected GitHub account for this project and link it.",
      inputSchema: z.object({
        project: z.string().describe("Project URL name (slug) or id"),
        private_repo: z.boolean().optional().describe("Create a private repository (default true)"),
      }),
    },
    async ({ project: ref, private_repo }) =>
      runTool(async () => {
        requireWriteScope(ctx);
        const project = await resolveProject(ctx, ref);
        const { repo } = await createRepoForProject(ctx.env, ctx.db, ctx.user, project, { privateRepo: private_repo });
        return { linked: true, fullName: repo.repo_full_name, url: repo.repo_url, defaultBranch: repo.default_branch };
      }),
  );

  server.registerTool(
    "github_sync_project",
    {
      title: "Sync project to GitHub",
      description:
        "Push the project's current source files to its linked repository as one commit. Refuses if secrets are detected in the source.",
      inputSchema: z.object({ project: z.string().describe("Project URL name (slug) or id") }),
    },
    async ({ project: ref }) =>
      runTool(async () => {
        requireWriteScope(ctx);
        const project = await resolveProject(ctx, ref);
        return await syncProjectToGitHub(ctx.env, ctx.db, ctx.user, project);
      }),
  );

  server.registerTool(
    "github_disconnect",
    {
      title: "Disconnect GitHub repository",
      description: "Remove the link between this project and its GitHub repository (the repo itself is kept).",
      inputSchema: z.object({ project: z.string().describe("Project URL name (slug) or id") }),
    },
    async ({ project: ref }) =>
      runTool(async () => {
        requireWriteScope(ctx);
        const project = await resolveProject(ctx, ref);
        await disconnectRepo(ctx.db, ctx.user, project);
        return { disconnected: true, project: project.slug };
      }),
  );
}
