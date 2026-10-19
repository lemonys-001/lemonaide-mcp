/**
 * Shared helpers for MCP tool implementations: project resolution, result
 * formatting, and scope checks.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { ErrorCode, LemonAIdeError } from "@lemonaide/shared";
import type { Env } from "../../env";
import { getSupabaseServiceClient } from "../../db/supabase";
import * as repos from "../../db/repos";

export interface ToolUser {
  userId: string;
  username: string;
  via: "mcp";
  scopes: string[];
}

export interface ToolContext {
  env: Env;
  db: SupabaseClient;
  user: ToolUser;
}

export function toolContext(env: Env, user: Omit<ToolUser, "via">): ToolContext {
  return { env, db: getSupabaseServiceClient(env), user: { ...user, via: "mcp" as const } };
}

export const WRITE_SCOPE = "mcp:write";

export function requireWriteScope(ctx: ToolContext): void {
  if (!ctx.user.scopes.includes(WRITE_SCOPE)) {
    throw new LemonAIdeError(
      ErrorCode.INSUFFICIENT_SCOPE,
      "this tool needs the mcp:write scope — re-authorize the connection and grant write access",
    );
  }
}

export async function resolveProject(ctx: ToolContext, ref: string): Promise<repos.Project> {
  const byId = await repos.getProject(ctx.db, ctx.user.userId, ref);
  if (byId) return byId;
  const bySlug = await repos.getProjectBySlug(ctx.db, ctx.user.userId, ref);
  if (bySlug) return bySlug;
  throw new LemonAIdeError(ErrorCode.NOT_FOUND, `no project named "${ref}" — use list_projects to see yours`);
}

export function textResult(data: unknown): { content: { type: "text"; text: string }[] } {
  return {
    content: [
      {
        type: "text",
        text: typeof data === "string" ? data : JSON.stringify(data, null, 2),
      },
    ],
  };
}

export function errorResult(err: unknown): { content: { type: "text"; text: string }[]; isError: true } {
  const text =
    err instanceof LemonAIdeError
      ? JSON.stringify({ error: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) })
      : JSON.stringify({ error: ErrorCode.INTERNAL, message: err instanceof Error ? err.message : String(err) });
  return { content: [{ type: "text", text }], isError: true };
}

/** Wrap a tool body: LemonAIdeError and unexpected errors become tool errors, never protocol errors. */
export async function runTool<T>(body: () => Promise<T>): Promise<{ content: { type: "text"; text: string }[] }> {
  try {
    return textResult(await body());
  } catch (err) {
    console.warn(JSON.stringify({ level: "warn", msg: "tool error", err: err instanceof Error ? err.message : String(err) }));
    return errorResult(err);
  }
}
