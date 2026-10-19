/**
 * Project lifecycle services: creation (with framework templates), rename,
 * archive/restore, deletion with confirmation, and health checks.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  DEFAULT_FRAMEWORK,
  ErrorCode,
  LIMITS,
  LemonAIdeError,
  slugify,
  type CreateProjectInputType,
  type Framework,
} from "@lemonaide/shared";
import type { Env } from "../env";
import * as repos from "../db/repos";
import { recordAudit } from "../db/profiles";
import {
  currentTreeRoot,
  deleteAllSource,
  deleteArtifacts,
  listSourceFiles,
  putSourceFile,
} from "../storage/source";

export interface Actor {
  userId: string;
  username: string;
  via: "mcp" | "dashboard";
}

export function liveUrlFor(env: Env, username: string, slug: string): string {
  const origin = env.APP_BASE_DOMAIN.startsWith("http")
    ? env.APP_BASE_DOMAIN
    : `https://${env.APP_BASE_DOMAIN}`;
  return `${origin}/${username}/${slug}`;
}

export interface ProjectTemplateFile {
  path: string;
  content: string;
}

export function templateFiles(framework: Framework, projectName: string): ProjectTemplateFile[] {
  const safeName = projectName.replace(/[<>&"]/g, "");
  switch (framework) {
    case "vite-react-ts":
      return [
        {
          path: "package.json",
          content: JSON.stringify(
            {
              name: "lemonaide-app",
              private: true,
              version: "0.0.1",
              type: "module",
              scripts: { dev: "vite", build: "vite build", preview: "vite preview" },
              dependencies: { react: "^19.3.1", "react-dom": "^19.3.1" },
              devDependencies: {
                "@types/react": "^19.2.0",
                "@types/react-dom": "^19.2.0",
                "@vitejs/plugin-react": "^5.0.0",
                typescript: "^5.9.0",
                vite: "^7.1.0",
              },
            },
            null,
            2,
          ),
        },
        { path: "index.html", content: `<!doctype html>\n<html lang="en">\n  <head>\n    <meta charset="UTF-8" />\n    <meta name="viewport" content="width=device-width, initial-scale=1.0" />\n    <title>${safeName}</title>\n  </head>\n  <body>\n    <div id="root"></div>\n    <script type="module" src="/src/main.tsx"></script>\n  </body>\n</html>\n` },
        {
          path: "vite.config.ts",
          content: `import { defineConfig } from "vite";\nimport react from "@vitejs/plugin-react";\n\nexport default defineConfig({\n  plugins: [react()],\n});\n`,
        },
        {
          path: "tsconfig.json",
          content: JSON.stringify(
            {
              compilerOptions: {
                target: "ES2022",
                lib: ["ES2022", "DOM", "DOM.Iterable"],
                module: "ESNext",
                moduleResolution: "bundler",
                jsx: "react-jsx",
                strict: true,
                skipLibCheck: true,
                noEmit: true,
              },
              include: ["src"],
            },
            null,
            2,
          ),
        },
        { path: "src/main.tsx", content: `import { createRoot } from "react-dom/client";\nimport { App } from "./App";\nimport "./styles.css";\n\ncreateRoot(document.getElementById("root")!).render(<App />);\n` },
        { path: "src/App.tsx", content: `export function App() {\n  return (\n    <main style={{ fontFamily: "system-ui", padding: 40, textAlign: "center" }}>\n      <h1>${safeName}</h1>\n      <p>Built with LemonAIde.</p>\n    </main>\n  );\n}\n` },
        { path: "src/styles.css", content: `body {\n  margin: 0;\n  background: #0c0f0a;\n  color: #e8ece4;\n}\n` },
      ];
    case "vite-vanilla":
      return [
        {
          path: "package.json",
          content: JSON.stringify(
            {
              name: "lemonaide-app",
              private: true,
              version: "0.0.1",
              type: "module",
              scripts: { dev: "vite", build: "vite build", preview: "vite preview" },
              devDependencies: { vite: "^7.1.0" },
            },
            null,
            2,
          ),
        },
        { path: "index.html", content: `<!doctype html>\n<html lang="en">\n  <head>\n    <meta charset="UTF-8" />\n    <meta name="viewport" content="width=device-width, initial-scale=1.0" />\n    <title>${safeName}</title>\n    <link rel="stylesheet" href="/src/style.css" />\n  </head>\n  <body>\n    <main id="app"></main>\n    <script type="module" src="/src/main.js"></script>\n  </body>\n</html>\n` },
        { path: "src/main.js", content: `document.querySelector("#app").innerHTML = \`\n  <h1>${safeName}</h1>\n  <p>Built with LemonAIde.</p>\n\`;\n` },
        { path: "src/style.css", content: `body {\n  margin: 0;\n  font-family: system-ui, sans-serif;\n  background: #0c0f0a;\n  color: #e8ece4;\n}\n` },
      ];
    case "vanilla-html":
    case "static-site":
    default:
      return [
        {
          path: "index.html",
          content: `<!doctype html>\n<html lang="en">\n  <head>\n    <meta charset="UTF-8" />\n    <meta name="viewport" content="width=device-width, initial-scale=1.0" />\n    <title>${safeName}</title>\n    <link rel="stylesheet" href="styles.css" />\n  </head>\n  <body>\n    <main>\n      <h1>${safeName}</h1>\n      <p>Built with LemonAIde.</p>\n    </main>\n    <script src="app.js"></script>\n  </body>\n</html>\n`,
        },
        {
          path: "styles.css",
          content: `* { box-sizing: border-box; }\nbody {\n  margin: 0;\n  min-height: 100vh;\n  display: grid;\n  place-items: center;\n  font-family: system-ui, sans-serif;\n  background: #0c0f0a;\n  color: #e8ece4;\n  text-align: center;\n}\n`,
        },
        { path: "app.js", content: `console.log("Hello from LemonAIde");\n` },
      ];
  }
}

async function uniqueSlug(db: SupabaseClient, ownerId: string, desired: string, explicit: boolean): Promise<string> {
  const existing = await repos.listProjects(db, ownerId, { status: "all", limit: 100 });
  const taken = new Set(existing.map((p) => p.slug));
  if (!taken.has(desired)) return desired;
  if (explicit) {
    throw new LemonAIdeError(ErrorCode.ALREADY_EXISTS, `URL name "${desired}" is already used by another of your projects`);
  }
  for (let i = 2; i <= 20; i++) {
    const candidate = `${desired}-${i}`.slice(0, LIMITS.slugMax);
    if (!taken.has(candidate)) return candidate;
  }
  throw new LemonAIdeError(ErrorCode.ALREADY_EXISTS, "could not find a free URL name — specify an explicit slug");
}

export async function createProject(
  env: Env,
  db: SupabaseClient,
  actor: Actor,
  input: CreateProjectInputType,
): Promise<repos.Project> {
  const count = await repos.countProjects(db, actor.userId);
  if (count >= LIMITS.maxProjectsPerUser) {
    throw new LemonAIdeError(ErrorCode.QUOTA_EXCEEDED, `project limit reached (${LIMITS.maxProjectsPerUser})`);
  }

  const slug = await uniqueSlug(db, actor.userId, input.slug ?? slugify(input.name), Boolean(input.slug));
  const project = await repos.insertProject(db, {
    ownerId: actor.userId,
    name: input.name,
    slug,
    description: input.description,
    framework: input.framework ?? DEFAULT_FRAMEWORK,
  });

  // Seed the working tree with the framework template.
  const files = templateFiles(project.framework, project.name);
  for (const file of files) {
    const { size, sha256 } = await putSourceFile(env.BLOB_STORE, project.id, file.path, file.content);
    await repos.upsertFileRows(db, project.id, [{ path: file.path, size, sha256 }]);
  }

  await recordAudit(db, {
    userId: actor.userId,
    actorType: actor.via,
    action: "project.create",
    targetType: "project",
    targetId: project.id,
    meta: { slug: project.slug, framework: project.framework },
  });

  return project;
}

export async function renameProject(
  env: Env,
  db: SupabaseClient,
  actor: Actor,
  project: repos.Project,
  name: string,
  updateSlug: boolean,
): Promise<repos.Project> {
  void env;
  const patch: { name: string; slug?: string } = { name };
  if (updateSlug) {
    const candidate = slugify(name);
    if (candidate !== project.slug) {
      await assertSlugFree(db, actor.userId, project.id, candidate);
      patch.slug = candidate;
    }
  }
  const updated = await repos.updateProject(db, actor.userId, project.id, patch);

  // Keep live routing in sync: deployment rows carry username+slug.
  if (patch.slug && patch.slug !== project.slug) {
    await db.from("deployments").update({ slug: patch.slug }).eq("project_id", project.id);
  }

  await recordAudit(db, {
    userId: actor.userId,
    actorType: actor.via,
    action: "project.rename",
    targetType: "project",
    targetId: project.id,
    meta: { name, slug: patch.slug ?? project.slug },
  });
  return updated;
}

async function assertSlugFree(db: SupabaseClient, ownerId: string, projectId: string, slug: string): Promise<void> {
  const existing = await repos.listProjects(db, ownerId, { status: "all", limit: 100 });
  const clash = existing.find((p) => p.slug === slug && p.id !== projectId);
  if (clash) {
    throw new LemonAIdeError(ErrorCode.ALREADY_EXISTS, `URL name "${slug}" is already used by another of your projects`);
  }
}

export async function setProjectArchived(
  db: SupabaseClient,
  actor: Actor,
  project: repos.Project,
  archived: boolean,
): Promise<repos.Project> {
  const updated = await repos.updateProject(db, actor.userId, project.id, { status: archived ? "archived" : "active" });
  await recordAudit(db, {
    userId: actor.userId,
    actorType: actor.via,
    action: archived ? "project.archive" : "project.restore",
    targetType: "project",
    targetId: project.id,
  });
  return updated;
}

export async function deleteProjectFully(
  env: Env,
  db: SupabaseClient,
  actor: Actor,
  project: repos.Project,
  confirmSlug: string,
): Promise<void> {
  if (confirmSlug !== project.slug) {
    throw new LemonAIdeError(ErrorCode.CONFIRMATION_REQUIRED, `confirmation must equal the project URL name ("${project.slug}")`);
  }

  // Collect artifact prefixes before the DB cascade removes the build rows.
  const artifactPrefixes = await collectArtifactPrefixes(db, project.id);

  // Remove live routing first (supersede current deployment rows via RLS-safe service call).
  await repos.clearCurrentDeployment(db, project.id, actor.userId).catch(() => undefined);
  await repos.deleteProject(db, actor.userId, project.id);

  // Cascade removed DB rows; now purge object storage.
  await deleteAllSource(env.BLOB_STORE, project.id);
  for (const prefix of artifactPrefixes) {
    await deleteArtifacts(env.BLOB_STORE, prefix);
  }

  await recordAudit(db, {
    userId: actor.userId,
    actorType: actor.via,
    action: "project.delete",
    targetType: "project",
    targetId: project.id,
    meta: { slug: project.slug },
  });
}

async function collectArtifactPrefixes(db: SupabaseClient, projectId: string): Promise<string[]> {
  const { data, error } = await db
    .from("builds")
    .select("artifact_prefix")
    .eq("project_id", projectId)
    .not("artifact_prefix", "is", null);
  if (error) throw new LemonAIdeError(ErrorCode.INTERNAL, "failed to list build artifacts", { cause: error });
  return (data ?? []).map((row) => row.artifact_prefix as string).filter(Boolean);
}

/* ------------------------------------------------------------------ */
/* Validation                                                          */
/* ------------------------------------------------------------------ */

export interface ValidationIssue {
  severity: "error" | "warning";
  code: string;
  message: string;
  path?: string;
}

const PACKAGE_NAME_RE = /^(?:@[a-z0-9-*~][a-z0-9-*._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;
const PACKAGE_SPEC_FORBIDDEN = /^(git\+|file:|link:|https?:|git:|ssh:|portal:|workspace:|catalog:|data:)/i;

export async function validateProject(env: Env, project: repos.Project): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = [];
  const files = await listSourceFiles(env.BLOB_STORE, project.id);

  if (files.length === 0) {
    issues.push({ severity: "error", code: "EMPTY_PROJECT", message: "project has no files" });
    return issues;
  }

  const paths = new Set(files.map((f) => f.path));

  if (project.framework === "vanilla-html" || project.framework === "static-site") {
    if (!paths.has("index.html")) {
      issues.push({ severity: "error", code: "MISSING_INDEX", message: "index.html is required for static sites", path: "index.html" });
    }
  }

  if (project.framework === "vite-react-ts" || project.framework === "vite-vanilla") {
    if (!paths.has("package.json")) {
      issues.push({ severity: "error", code: "MISSING_PACKAGE_JSON", message: "package.json is required for Vite projects", path: "package.json" });
    }
    if (!paths.has("index.html")) {
      issues.push({ severity: "error", code: "MISSING_INDEX", message: "index.html is required for Vite projects", path: "index.html" });
    }
  }

  if (paths.has("package.json")) {
    const raw = await readProjectFileRaw(env, project.id, "package.json");
    try {
      const pkg = JSON.parse(raw ?? "{}") as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
        scripts?: Record<string, string>;
        name?: string;
        version?: string;
      };
      for (const [dep, spec] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })) {
        if (!PACKAGE_NAME_RE.test(dep)) {
          issues.push({ severity: "error", code: "BAD_PACKAGE_NAME", message: `invalid dependency name "${dep}"`, path: "package.json" });
        }
        if (typeof spec === "string" && PACKAGE_SPEC_FORBIDDEN.test(spec)) {
          issues.push({
            severity: "error",
            code: "FORBIDDEN_DEPENDENCY_SPEC",
            message: `dependency "${dep}" uses a forbidden source ("${spec}") — only registry versions are allowed`,
            path: "package.json",
          });
        }
      }
      if (pkg.scripts) {
        for (const name of ["preinstall", "install", "postinstall", "prepare"]) {
          if (pkg.scripts[name]) {
            issues.push({
              severity: "warning",
              code: "LIFECYCLE_SCRIPT",
              message: `"${name}" scripts are ignored by the sandboxed builder`,
              path: "package.json",
            });
          }
        }
      }
    } catch {
      issues.push({ severity: "error", code: "PACKAGE_JSON_INVALID", message: "package.json is not valid JSON", path: "package.json" });
    }
  }

  const totalBytes = files.reduce((acc, f) => acc + f.size, 0);
  if (totalBytes > LIMITS.projectTotalMaxBytes) {
    issues.push({
      severity: "error",
      code: "SOURCE_TOO_LARGE",
      message: `source is ${totalBytes} bytes, limit is ${LIMITS.projectTotalMaxBytes}`,
    });
  }
  if (files.length > LIMITS.snapshotMaxFiles) {
    issues.push({
      severity: "error",
      code: "TOO_MANY_FILES",
      message: `project has ${files.length} files, limit is ${LIMITS.snapshotMaxFiles}`,
    });
  }

  return issues;
}

async function readProjectFileRaw(env: Env, projectId: string, path: string): Promise<string | null> {
  const { getSourceFile } = await import("../storage/source");
  return getSourceFile(env.BLOB_STORE, projectId, path);
}

export function issuesToError(issues: ValidationIssue[]): LemonAIdeError | null {
  const errors = issues.filter((i) => i.severity === "error");
  if (errors.length === 0) return null;
  return new LemonAIdeError(ErrorCode.INVALID_INPUT, `project validation failed: ${errors.map((e) => e.code).join(", ")}`, {
    details: { issues: errors },
  });
}

export { currentTreeRoot };
