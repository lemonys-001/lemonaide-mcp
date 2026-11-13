export interface Env {
  ENVIRONMENT: string;
  APP_BASE_DOMAIN: string;
  MCP_PUBLIC_URL: string;

  OAUTH_KV: KVNamespace;
  BLOB_STORE: KVNamespace;
  BUILD_QUEUE: Queue;
  DASHBOARD: Fetcher;

  SUPABASE_URL: string;
  SUPABASE_ANON_KEY: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  SUPABASE_JWT_ISSUER?: string;

  SESSION_SECRET?: string;
  CONSENT_SECRET?: string;

  GITHUB_APP_ID?: string;
  GITHUB_APP_SLUG?: string;
  GITHUB_APP_CLIENT_ID?: string;
  GITHUB_APP_CLIENT_SECRET?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
  GITHUB_APP_WEBHOOK_SECRET?: string;

  BUILD_RUNNER_TOKEN?: string;
  BUILD_DISPATCH_TOKEN?: string;
  PLATFORM_REPO?: string;

  /** Development-only fake auth. Must never be set in production. */
  DEV_FAKE_AUTH?: string;
}

export function isProduction(env: Env): boolean {
  return env.ENVIRONMENT === "production";
}

export function mcpResource(env: Env): string {
  return env.MCP_PUBLIC_URL;
}

export function primaryOrigin(env: Env): string {
  return env.APP_BASE_DOMAIN.startsWith("http")
    ? env.APP_BASE_DOMAIN
    : `https://${env.APP_BASE_DOMAIN}`;
}
