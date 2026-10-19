/**
 * MCP server assembly: builds a per-request McpServer bound to the
 * authorized user (props injected by workers-oauth-provider) and exposes
 * a fetch-shaped apiHandler for OAuthProvider's apiRoute.
 */

import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";
import type { Env } from "../env";
import { registerProjectTools } from "./tools/projects";
import { registerBuildTools } from "./tools/builds";
import { registerDeployTools } from "./tools/deploys";
import { registerGithubTools } from "./tools/github";
import { registerMetaTools } from "./tools/meta";
import { toolContext, type ToolContext } from "./tools/common";

export interface McpProps {
  userId: string;
  username: string;
  grantId?: string;
}

/** `ctx.auth` as set by workers-oauth-provider (OAuthResourceAuth shape). */
export interface McpAuth {
  token: string;
  audience: string;
  scope: string[];
  clientId?: string;
  userId?: string;
  expiresAt?: number;
}

/**
 * The shape workers-oauth-provider builds on top of ExecutionContext for its
 * apiHandler: decrypted grant props + verified token auth. fetch() accepts the
 * plain ExecutionContext type (ExportedHandler compatibility) and narrows to
 * this shape at runtime.
 */
export interface McpApiContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException?(): void;
  props?: McpProps;
  auth?: McpAuth;
}

export const MCP_SERVER_INFO = { name: "lemonaide-mcp", version: "1.0.0" } as const;

export function createLemonAIdeServer(env: Env, user: Omit<ToolContext["user"], "via">): McpServer {
  const server = new McpServer(MCP_SERVER_INFO);
  const ctx = toolContext(env, user);
  registerMetaTools(server, ctx);
  registerProjectTools(server, ctx);
  registerBuildTools(server, ctx);
  registerDeployTools(server, ctx);
  registerGithubTools(server, ctx);
  return server;
}

/**
 * apiHandler for OAuthProvider: the provider has already validated the
 * bearer token and injected props/auth; we hand them to a per-request
 * stateless MCP handler (2025-era clients served via the legacy fallback).
 */
export function createMcpApiHandler() {
  return {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
      const { props, auth } = ctx as McpApiContext;
      if (!props?.userId) {
        return Response.json(
          { error: "unauthorized", message: "missing authorization props" },
          { status: 401 },
        );
      }

      // Track grant activity (best-effort).
      if (props.grantId) {
        const grantId = props.grantId;
        ctx.waitUntil(
          import("../db/supabase")
            .then(({ getSupabaseServiceClient }) => getSupabaseServiceClient(env))
            .then((db) => import("../db/repos").then((repos) => repos.touchMcpAuthorization(db, props.userId, grantId)))
            .catch(() => undefined),
        );
      }

      const handler = createMcpHandler(
        () =>
          createLemonAIdeServer(env, {
            userId: props.userId,
            username: props.username,
            scopes: auth?.scope ?? ["mcp:read", "mcp:write", "offline_access"],
          }),
        {
          legacy: "stateless",
          onerror: (err) => console.error(JSON.stringify({ level: "error", msg: "mcp error", err: err.message })),
        },
      );

      return handler.fetch(request);
    },
  };
}
