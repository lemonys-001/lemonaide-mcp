/**
 * LemonAIde MCP — Worker entry point.
 *
 * Single-worker topology:
 *   /mcp                  MCP Streamable HTTP (OAuthProvider apiRoute → apiHandler)
 *   /authorize            OAuth 2.1 consent + sign-in page (Supabase
 *                         email/password grant; provider owns the AS)
 *   /api/*                Dashboard REST + build-runner internals
 *   /{username}/{slug}/*  Published static apps
 *   everything else       Dashboard SPA (assets binding)
 */

import { OAuthError, OAuthProvider } from "@cloudflare/workers-oauth-provider";
import type { Env } from "./env";
import { createMcpApiHandler } from "./mcp/server";
import { createApiRouter } from "./api/router";
import { isReservedTopLevel, servePublishedApp } from "./app-router";
import { handleAuthorizeGet, handleAuthorizePost } from "./auth/authorize";
import { dispatchBuild } from "./services/builds";
import { getSupabaseServiceClient } from "./db/supabase";

const SCOPES_SUPPORTED = ["mcp:read", "mcp:write", "offline_access"] as const;

function withTrailingSlashFree(value: string): string {
  return value.replace(/\/+$/, "");
}

function buildProvider(env: Env): OAuthProvider<Env> {
  const resource = withTrailingSlashFree(env.MCP_PUBLIC_URL);
  return new OAuthProvider<Env>({
    apiRoute: "/mcp",
    apiHandler: createMcpApiHandler(),
    defaultHandler,
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/oauth/token",
    resourceMetadata: { resource },
    requiredScopes: ["mcp:read"],
    scopesSupported: [...SCOPES_SUPPORTED],
    accessTokenTTL: 3600,
    // MCP client onboarding: DCR works for all MCP SDK-based clients
    // (Claude, OpenCode, Cursor, …); CIMD covers clients that prefer
    // Client ID Metadata Documents.
    clientRegistrationEndpoint: "/oauth/register",
    clientIdMetadataDocumentEnabled: true,
    // Upstream (Supabase) refresh: keep the user's grant alive across MCP sessions.
    tokenExchangeCallback: async ({ grantType, props }) => {
      if (grantType !== "refresh_token") return;
      const upstreamRefresh = (props as { supabaseRefreshToken?: string } | null)?.supabaseRefreshToken;
      if (!upstreamRefresh) return;
      const res = await fetch(`${env.SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
        method: "POST",
        headers: { "content-type": "application/json", apikey: env.SUPABASE_ANON_KEY },
        body: JSON.stringify({ refresh_token: upstreamRefresh }),
      });
      if (res.status === 400 || res.status === 401 || res.status === 403) {
        throw new OAuthError("invalid_grant", { description: "Supabase session was revoked or expired" });
      }
      if (!res.ok) {
        throw new OAuthError("temporarily_unavailable", { description: "Supabase is unavailable", statusCode: 503 });
      }
      const data = (await res.json()) as { refresh_token?: string };
      return { newProps: { ...(props ?? {}), supabaseRefreshToken: data.refresh_token ?? upstreamRefresh } };
    },
    onError: ({ status, code, internal }) => {
      console.warn(JSON.stringify({ level: "warn", msg: "oauth error", status, code, ...internal }));
    },
  });
}

const defaultHandler = {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/healthz") {
      return Response.json({ ok: true, service: "lemonaide-mcp" });
    }

    if (path === "/authorize" && (request.method === "GET" || request.method === "POST")) {
      return request.method === "GET" ? handleAuthorizeGet(request, env) : handleAuthorizePost(request, env);
    }

    if (path === "/api" || path.startsWith("/api/")) {
      return createApiRouter(env).fetch(request, _ctx);
    }

    // Published apps: /{username}/{slug}[/...]
    const segments = path.split("/").filter(Boolean);
    const first = segments[0];
    if (first && !isReservedTopLevel(first)) {
      const username = decodeURIComponent(first);
      const slug = segments[1] ? decodeURIComponent(segments[1]) : "";
      if (slug) {
        const rest = segments.slice(2).join("/");
        return servePublishedApp(request, env, username, slug, rest);
      }
    }

    // Dashboard SPA + its assets (assets binding).
    return env.DASHBOARD.fetch(request);
  },
};

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // Provider is built per request so the canonical resource follows MCP_PUBLIC_URL.
    const provider = buildProvider(env);
    return provider.fetch(request, env, ctx);
  },

  /** Build queue: dispatch each job to the isolated GitHub Actions runner. */
  async queue(messages: MessageBatch<{ buildId: string; projectId: string }>, env: Env): Promise<void> {
    const db = getSupabaseServiceClient(env);
    for (const message of messages.messages) {
      try {
        await dispatchBuild(env, db, message.body.buildId);
        message.ack();
      } catch (err) {
        console.error(
          JSON.stringify({ level: "error", msg: "queue dispatch failed", buildId: message.body.buildId, err: err instanceof Error ? err.message : String(err) }),
        );
        message.retry();
      }
    }
  },
};
