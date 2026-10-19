/**
 * Project + file tools: the core surface MCP clients use to list, create,
 * edit, and manage projects.
 */

import { z } from "zod/v4";
import type { McpServer } from "@modelcontextprotocol/server";
import {
  ErrorCode,
  LIMITS,
  LemonAIdeError,
  frameworkSchema,
  projectFileContentSchema,
  projectNameSchema,
  projectPathSchema,
  projectSlugSchema,
} from "@lemonaide/shared";
import * as repos from "../../db/repos";
import { deleteSourceFile, getSourceFile, listSourceFiles, putSourceFile } from "../../storage/source";
import { liveUrlFor, createProject, renameProject, setProjectArchived, deleteProjectFully } from "../../services/projects";
import { requireWriteScope, resolveProject, runTool, type ToolContext } from "./common";

function describeProject(ctx: ToolContext, project: repos.Project): Record<string, unknown> {
  return {
    id: project.id,
    name: project.name,
    slug: project.slug,
    description: project.description,
    framework: project.framework,
    status: project.status,
    liveUrl: liveUrlFor(ctx.env, ctx.user.username, project.slug),
    createdAt: project.created_at,
    updatedAt: project.updated_at,
  };
}

export function registerProjectTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "list_projects",
    {
      title: "List projects",
      description: `List your projects with their status and live URLs. Optional filter by status (default: active).`,
      inputSchema: z.object({
        status: z.enum(["active", "archived", "all"]).optional().describe("Filter by project status"),
      }),
    },
    async ({ status }) =>
      runTool(async () => {
        const projects = await repos.listProjects(ctx.db, ctx.user.userId, { status: status ?? "active" });
        return projects.map((p) => describeProject(ctx, p));
      }),
  );

  server.registerTool(
    "get_project",
    {
      title: "Get project",
      description: "Get one project by URL name (slug) or id, including its current deployment.",
      inputSchema: z.object({ project: z.string().describe("Project URL name (slug) or id") }),
    },
    async ({ project: ref }) =>
      runTool(async () => {
        const project = await resolveProject(ctx, ref);
        const current = await repos.getCurrentDeploymentByProject(ctx.db, project.id);
        return {
          ...describeProject(ctx, project),
          currentDeployment: current
            ? {
                id: current.id,
                number: current.deployment_number,
                status: current.status,
                deployedAt: current.deployed_at,
                buildId: current.build_id,
              }
            : null,
        };
      }),
  );

  server.registerTool(
    "create_project",
    {
      title: "Create project",
      description: `Create a new project seeded with a working starter for the chosen framework (${LIMITS.maxProjectsPerUser} projects max).`,
      inputSchema: z.object({
        name: projectNameSchema,
        description: z.string().max(LIMITS.descriptionMax).optional(),
        framework: frameworkSchema.optional(),
        slug: projectSlugSchema.optional().describe("Explicit URL name; derived from name when omitted"),
      }),
    },
    async (input) =>
      runTool(async () => {
        requireWriteScope(ctx);
        const project = await createProject(ctx.env, ctx.db, ctx.user, {
          ...input,
          framework: input.framework ?? "vanilla-html",
        });
        return describeProject(ctx, project);
      }),
  );

  server.registerTool(
    "update_project",
    {
      title: "Update project",
      description:
        "Rename a project, change its description, and optionally re-derive the URL name from the new name (update_slug).",
      inputSchema: z.object({
        project: z.string().describe("Project URL name (slug) or id"),
        name: projectNameSchema.optional(),
        description: z.string().max(LIMITS.descriptionMax).nullable().optional(),
        update_slug: z.boolean().optional().describe("Re-derive the URL name from the new name"),
      }),
    },
    async ({ project: ref, name, description, update_slug }) =>
      runTool(async () => {
        requireWriteScope(ctx);
        const project = await resolveProject(ctx, ref);
        let updated = project;
        if (name && name !== project.name) {
          updated = await renameProject(ctx.env, ctx.db, ctx.user, project, name, Boolean(update_slug));
        }
        if (description !== undefined) {
          updated = await repos.updateProject(ctx.db, ctx.user.userId, project.id, {
            description: description ?? null,
          });
        }
        return describeProject(ctx, updated);
      }),
  );

  server.registerTool(
    "archive_project",
    {
      title: "Archive project",
      description: "Archive a project. Archived projects stay listed with status filter but are hidden from list_projects by default.",
      inputSchema: z.object({ project: z.string().describe("Project URL name (slug) or id") }),
    },
    async ({ project: ref }) =>
      runTool(async () => {
        requireWriteScope(ctx);
        const project = await resolveProject(ctx, ref);
        return describeProject(ctx, await setProjectArchived(ctx.db, ctx.user, project, true));
      }),
  );

  server.registerTool(
    "restore_project",
    {
      title: "Restore project",
      description: "Restore an archived project to active.",
      inputSchema: z.object({ project: z.string().describe("Project URL name (slug) or id") }),
    },
    async ({ project: ref }) =>
      runTool(async () => {
        requireWriteScope(ctx);
        const project = await resolveProject(ctx, ref);
        return describeProject(ctx, await setProjectArchived(ctx.db, ctx.user, project, false));
      }),
  );

  server.registerTool(
    "delete_project",
    {
      title: "Delete project",
      description:
        "Permanently delete a project, its builds and deployments. The URL name stops serving immediately. Requires confirmation: pass confirm_slug exactly equal to the project's URL name.",
      inputSchema: z.object({
        project: z.string().describe("Project URL name (slug) or id"),
        confirm_slug: z.string().describe("Must equal the project's URL name (slug)"),
      }),
    },
    async ({ project: ref, confirm_slug }) =>
      runTool(async () => {
        requireWriteScope(ctx);
        const project = await resolveProject(ctx, ref);
        await deleteProjectFully(ctx.env, ctx.db, ctx.user, project, confirm_slug);
        return { deleted: true, project: project.slug, liveUrl: liveUrlFor(ctx.env, ctx.user.username, project.slug) };
      }),
  );

  /* ---------------------------------------------------------------- */
  /* Files                                                             */
  /* ---------------------------------------------------------------- */

  server.registerTool(
    "list_project_files",
    {
      title: "List project files",
      description: "List files in the project's working tree (optionally under a directory), with sizes.",
      inputSchema: z.object({
        project: z.string().describe("Project URL name (slug) or id"),
        directory: z.string().max(200).optional().describe("Relative directory to list"),
      }),
    },
    async ({ project: ref, directory }) =>
      runTool(async () => {
        const project = await resolveProject(ctx, ref);
        const files = await listSourceFiles(ctx.env.SOURCE_BUCKET, project.id, directory);
        return files.map((f) => ({ path: f.path, size: f.size }));
      }),
  );

  server.registerTool(
    "read_project_file",
    {
      title: "Read project file",
      description: "Read the current contents of one source file.",
      inputSchema: z.object({
        project: z.string().describe("Project URL name (slug) or id"),
        path: projectPathSchema,
      }),
    },
    async ({ project: ref, path }) =>
      runTool(async () => {
        const project = await resolveProject(ctx, ref);
        const content = await getSourceFile(ctx.env.SOURCE_BUCKET, project.id, path);
        if (content === null) throw new LemonAIdeError(ErrorCode.NOT_FOUND, `no file at "${path}"`);
        return { path, content, bytes: content.length };
      }),
  );

  server.registerTool(
    "write_project_file",
    {
      title: "Write project file",
      description: `Create or overwrite one source file (max ${Math.floor(LIMITS.projectFileMaxBytes / 1024)} KiB per file).`,
      inputSchema: z.object({
        project: z.string().describe("Project URL name (slug) or id"),
        path: projectPathSchema,
        content: projectFileContentSchema,
      }),
    },
    async ({ project: ref, path, content }) =>
      runTool(async () => {
        requireWriteScope(ctx);
        const project = await resolveProject(ctx, ref);
        if (new TextEncoder().encode(content).byteLength > LIMITS.projectFileMaxBytes) {
          throw new LemonAIdeError(ErrorCode.PAYLOAD_TOO_LARGE, `file exceeds ${LIMITS.projectFileMaxBytes} bytes`);
        }
        const { size, sha256 } = await putSourceFile(ctx.env.SOURCE_BUCKET, project.id, path, content);
        await repos.upsertFileRows(ctx.db, project.id, [{ path, size, sha256 }]);
        return { path, size, sha256, written: true };
      }),
  );

  server.registerTool(
    "write_project_files",
    {
      title: "Write project files (batch)",
      description: "Create or overwrite several source files in one call. Ideal for scaffolding an app in one shot.",
      inputSchema: z.object({
        project: z.string().describe("Project URL name (slug) or id"),
        files: z
          .array(
            z.object({
              path: projectPathSchema,
              content: projectFileContentSchema,
            }),
          )
          .min(1)
          .max(100),
      }),
    },
    async ({ project: ref, files }) =>
      runTool(async () => {
        requireWriteScope(ctx);
        const project = await resolveProject(ctx, ref);
        const results = [];
        for (const file of files) {
          if (new TextEncoder().encode(file.content).byteLength > LIMITS.projectFileMaxBytes) {
            throw new LemonAIdeError(ErrorCode.PAYLOAD_TOO_LARGE, `${file.path} exceeds ${LIMITS.projectFileMaxBytes} bytes`);
          }
          const { size, sha256 } = await putSourceFile(ctx.env.SOURCE_BUCKET, project.id, file.path, file.content);
          results.push({ path: file.path, size, sha256 });
        }
        await repos.upsertFileRows(ctx.db, project.id, results);
        return { written: results.length, files: results };
      }),
  );

  server.registerTool(
    "delete_project_file",
    {
      title: "Delete project file",
      description: "Delete one source file from the working tree.",
      inputSchema: z.object({
        project: z.string().describe("Project URL name (slug) or id"),
        path: projectPathSchema,
      }),
    },
    async ({ project: ref, path }) =>
      runTool(async () => {
        requireWriteScope(ctx);
        const project = await resolveProject(ctx, ref);
        const removed = await repos.deleteFileRow(ctx.db, project.id, path);
        if (!removed) throw new LemonAIdeError(ErrorCode.NOT_FOUND, `no file at "${path}"`);
        await deleteSourceFile(ctx.env.SOURCE_BUCKET, project.id, path);
        return { path, deleted: true };
      }),
  );

  server.registerTool(
    "validate_project",
    {
      title: "Validate project",
      description: "Run project validation (required files, dependency rules, size limits) without building.",
      inputSchema: z.object({ project: z.string().describe("Project URL name (slug) or id") }),
    },
    async ({ project: ref }) =>
      runTool(async () => {
        const project = await resolveProject(ctx, ref);
        const { validateProject } = await import("../../services/projects");
        const issues = await validateProject(ctx.env, project);
        return { valid: !issues.some((i) => i.severity === "error"), issues };
      }),
  );
}
