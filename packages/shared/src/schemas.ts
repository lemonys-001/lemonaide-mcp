import { z } from "zod";
import { FRAMEWORKS, LIMITS } from "./constants";
import { validateProjectPath } from "./paths";
import { isValidSlug, validateUsername } from "./slug";

/** ------------------------------------------------------------------
 * Primitives
 * ------------------------------------------------------------------ */

export const usernameSchema = z
  .string()
  .min(3)
  .max(LIMITS.usernameMax)
  .refine((v) => validateUsername(v) === null, { message: "invalid username" });

export const projectNameSchema = z
  .string()
  .min(LIMITS.projectNameMin)
  .max(LIMITS.projectNameMax)
  .transform((s) => s.trim());

export const projectSlugSchema = z
  .string()
  .min(1)
  .max(LIMITS.slugMax)
  .refine(isValidSlug, { message: "slug must be URL-safe (a-z, 0-9, hyphen)" });

export const frameworkSchema = z.enum(FRAMEWORKS);

export const projectPathSchema = z
  .string()
  .min(1)
  .refine((v) => validateProjectPath(v) === null, { message: "invalid or unsafe path" });

export const projectFileContentSchema = z.string().max(LIMITS.projectFileMaxBytes);

export const uuidSchema = z.string().uuid();

/** ------------------------------------------------------------------
 * Authentication & identity tools
 * ------------------------------------------------------------------ */

export const GetAccountLimitsInput = z.object({});

export const GetMcpConnectionInfoInput = z.object({});

/** ------------------------------------------------------------------
 * Project tools
 * ------------------------------------------------------------------ */

export const CreateProjectInput = z.object({
  name: projectNameSchema,
  framework: frameworkSchema.default("vanilla-html"),
  description: z.string().max(LIMITS.descriptionMax).optional(),
  slug: projectSlugSchema.optional(),
});

export const ListProjectsInput = z.object({
  status: z.enum(["active", "archived", "all"]).default("active"),
  limit: z.number().int().min(1).max(100).default(50),
});

export const GetProjectInput = z.object({
  project_id: uuidSchema,
});

export const RenameProjectInput = z.object({
  project_id: uuidSchema,
  name: projectNameSchema,
  /** Change the public URL slug as well (default true). */
  update_slug: z.boolean().default(true),
});

export const ProjectActionInput = z.object({
  project_id: uuidSchema,
});

export const DeleteProjectInput = z.object({
  project_id: uuidSchema,
  /** Must equal the project slug to confirm destructive deletion. */
  confirm_slug: z.string().min(1),
});

/** ------------------------------------------------------------------
 * File tools
 * ------------------------------------------------------------------ */

export const ListProjectFilesInput = z.object({
  project_id: uuidSchema,
  directory: z.string().max(400).optional(),
});

export const ReadProjectFileInput = z.object({
  project_id: uuidSchema,
  path: projectPathSchema,
});

export const WriteProjectFileInput = z.object({
  project_id: uuidSchema,
  path: projectPathSchema,
  content: projectFileContentSchema,
});

export const WriteProjectFilesInput = z.object({
  project_id: uuidSchema,
  files: z
    .array(
      z.object({
        path: projectPathSchema,
        content: projectFileContentSchema,
      }),
    )
    .min(1)
    .max(100),
});

export const DeleteProjectFileInput = z.object({
  project_id: uuidSchema,
  path: projectPathSchema,
});

export const MoveProjectFileInput = z.object({
  project_id: uuidSchema,
  from: projectPathSchema,
  to: projectPathSchema,
});

export const GetProjectSnapshotInput = z.object({
  project_id: uuidSchema,
});

export const RestoreProjectSnapshotInput = z.object({
  project_id: uuidSchema,
  version: z.number().int().min(1),
});

/** ------------------------------------------------------------------
 * Build tools
 * ------------------------------------------------------------------ */

export const ValidateProjectInput = z.object({
  project_id: uuidSchema,
});

export const InstallDependenciesInput = z.object({
  project_id: uuidSchema,
  idempotency_key: z.string().min(8).max(128).optional(),
});

export const BuildProjectInput = z.object({
  project_id: uuidSchema,
  install_dependencies: z.boolean().default(true),
  idempotency_key: z.string().min(8).max(128).optional(),
});

export const GetBuildStatusInput = z.object({
  build_id: uuidSchema,
});

export const GetBuildLogsInput = z.object({
  build_id: uuidSchema,
  /** Optional byte offset for chunked retrieval. */
  offset: z.number().int().min(0).default(0),
  /** Max bytes to return. */
  limit: z.number().int().min(1).max(64 * 1024).default(16 * 1024),
});

/** ------------------------------------------------------------------
 * GitHub tools
 * ------------------------------------------------------------------ */

export const CreateGithubRepositoryInput = z.object({
  project_id: uuidSchema,
  repository_name: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[a-zA-Z0-9._-]+$/, "invalid repository name")
    .optional(),
  visibility: z.enum(["private", "public"]).default("private"),
  description: z.string().max(350).optional(),
});

export const SyncProjectToGithubInput = z.object({
  project_id: uuidSchema,
  commit_message: z.string().min(1).max(500).optional(),
  /** Optional idempotency guard against duplicate pushes. */
  idempotency_key: z.string().min(8).max(128).optional(),
});

export const GetGithubStatusInput = z.object({
  project_id: uuidSchema,
});

export const GetGithubCommitsInput = z.object({
  project_id: uuidSchema,
  limit: z.number().int().min(1).max(50).default(10),
});

/** ------------------------------------------------------------------
 * Deployment tools
 * ------------------------------------------------------------------ */

export const DeployProjectInput = z.object({
  project_id: uuidSchema,
  build_id: uuidSchema.optional(),
  idempotency_key: z.string().min(8).max(128).optional(),
});

export const GetDeploymentStatusInput = z.object({
  deployment_id: uuidSchema,
});

export const ListDeploymentsInput = z.object({
  project_id: uuidSchema,
  limit: z.number().int().min(1).max(50).default(20),
});

export const RollbackDeploymentInput = z.object({
  project_id: uuidSchema,
  deployment_id: uuidSchema,
});

export const UnpublishProjectInput = z.object({
  project_id: uuidSchema,
  confirm: z.literal(true),
});

export const GetLiveUrlInput = z.object({
  project_id: uuidSchema,
});

/** ------------------------------------------------------------------
 * Optional tools
 * ------------------------------------------------------------------ */

export const DuplicateProjectInput = z.object({
  project_id: uuidSchema,
  name: projectNameSchema.optional(),
});

export const CreateProjectFromTemplateInput = z.object({
  template: z.enum(["todo", "landing", "portfolio", "blank"]),
  name: projectNameSchema,
  framework: frameworkSchema.optional(),
});

export const ExportProjectArchiveInput = z.object({
  project_id: uuidSchema,
});

export const CheckProjectHealthInput = z.object({
  project_id: uuidSchema,
});

export type CreateProjectInputType = z.infer<typeof CreateProjectInput>;
export type WriteProjectFileInputType = z.infer<typeof WriteProjectFileInput>;
export type BuildProjectInputType = z.infer<typeof BuildProjectInput>;
export type DeployProjectInputType = z.infer<typeof DeployProjectInput>;
