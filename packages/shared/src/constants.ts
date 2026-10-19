/** Supported frameworks for the first release (static-output only). */
export const FRAMEWORKS = ["vanilla-html", "vite-react-ts", "vite-vanilla", "static-site"] as const;
export type Framework = (typeof FRAMEWORKS)[number];

export const DEFAULT_FRAMEWORK: Framework = "vanilla-html";

/** Per-framework build commands executed ONLY inside the isolated build runner. */
export const FRAMEWORK_BUILD_CONFIG: Record<
  Framework,
  { installCommand: string; buildCommand: string; outputDir: string }
> = {
  "vanilla-html": { installCommand: "", buildCommand: "", outputDir: "." },
  "vite-react-ts": { installCommand: "npm ci --no-audit --no-fund", buildCommand: "npm run build", outputDir: "dist" },
  "vite-vanilla": { installCommand: "npm ci --no-audit --no-fund", buildCommand: "npm run build", outputDir: "dist" },
  "static-site": { installCommand: "", buildCommand: "", outputDir: "." },
};

/** Usernames the platform reserves (URL-space protection). Kept in sync with SQL check. */
export const RESERVED_USERNAMES: ReadonlySet<string> = new Set([
  "api", "mcp", "oauth", "auth", "assets", "static", "app", "apps", "dashboard",
  "admin", "health", "login", "logout", "callback", "authorize", "register",
  "token", "www", "mail", "support", "help", "docs", "blog", "settings",
  "account", "projects", "lemonaide", "lemonai", "null", "undefined",
  "internal", "worker", "build", "builds", "deploy", "deploys",
]);

/** Resource quotas (v1 defaults; owner-tunable later via config table). */
export const LIMITS = {
  usernameMin: 3,
  usernameMax: 40,
  projectNameMin: 1,
  projectNameMax: 50,
  slugMax: 50,
  descriptionMax: 500,
  projectFileMaxBytes: 512 * 1024, // 512 KiB per source file
  projectTotalMaxBytes: 25 * 1024 * 1024, // 25 MiB source
  snapshotMaxFiles: 2000,
  artifactMaxFiles: 5000,
  artifactMaxBytes: 100 * 1024 * 1024, // 100 MiB built output
  buildTimeoutMs: 10 * 60 * 1000, // 10 minutes
  buildLogMaxBytes: 256 * 1024,
  maxProjectsPerUser: 25,
  maxBuildsPerDay: 50,
  maxDeploysPerDay: 50,
  maxDeploymentsPerProject: 30,
} as const;

/** Build state machine. */
export const BUILD_STATUSES = ["queued", "running", "succeeded", "failed", "canceled"] as const;
export type BuildStatus = (typeof BUILD_STATUSES)[number];

export const BUILD_TRANSITIONS: Record<BuildStatus, readonly BuildStatus[]> = {
  queued: ["running", "failed", "canceled"],
  running: ["succeeded", "failed", "canceled"],
  succeeded: [],
  failed: [],
  canceled: [],
};

/** Deployment state machine: CREATED → VALIDATING → BUILD_QUEUED → BUILDING →
 * BUILD_SUCCEEDED → DEPLOY_QUEUED → DEPLOYING → DEPLOYED (+ failure/cancel). */
export const DEPLOYMENT_STATUSES = [
  "pending",
  "deploying",
  "deployed",
  "failed",
  "superseded",
  "rolled_back",
] as const;
export type DeploymentStatus = (typeof DEPLOYMENT_STATUSES)[number];

export function canTransitionDeployment(from: DeploymentStatus, to: DeploymentStatus): boolean {
  const allowed: Record<DeploymentStatus, readonly DeploymentStatus[]> = {
    pending: ["deploying", "failed"],
    deploying: ["deployed", "failed"],
    deployed: ["superseded", "rolled_back"],
    failed: [],
    superseded: ["rolled_back"],
    rolled_back: [],
  };
  return allowed[from].includes(to);
}
