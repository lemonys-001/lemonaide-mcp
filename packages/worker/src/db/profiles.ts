import type { SupabaseClient } from "@supabase/supabase-js";
import { ErrorCode, LemonAIdeError } from "@lemonaide/shared";

export interface Profile {
  id: string;
  username: string;
  display_name: string | null;
  avatar_url: string | null;
  github_login: string | null;
  created_at: string;
}

export async function getProfile(db: SupabaseClient, userId: string): Promise<Profile | null> {
  const { data, error } = await db.from("profiles").select("*").eq("id", userId).maybeSingle();
  if (error) throw new LemonAIdeError(ErrorCode.INTERNAL, "failed to load profile", { cause: error });
  return (data as Profile | null) ?? null;
}

export async function requireProfile(db: SupabaseClient, userId: string): Promise<Profile> {
  const profile = await getProfile(db, userId);
  if (!profile) {
    throw new LemonAIdeError(ErrorCode.NOT_FOUND, "profile not found — complete sign-in first");
  }
  return profile;
}

export async function setUsername(db: SupabaseClient, userId: string, username: string): Promise<Profile> {
  const { data, error } = await db
    .from("profiles")
    .update({ username })
    .eq("id", userId)
    .select("*")
    .single();
  if (error) {
    if (error.code === "23505") {
      throw new LemonAIdeError(ErrorCode.ALREADY_EXISTS, "username is already taken");
    }
    throw new LemonAIdeError(ErrorCode.INTERNAL, "failed to set username", { cause: error });
  }
  return data as Profile;
}

/**
 * Return the profile, creating one if the auth-user trigger hasn't run
 * (or its username candidate was reserved). Used at MCP sign-in.
 */
export async function ensureProfile(
  db: SupabaseClient,
  userId: string,
  fallback: { username?: string; displayName?: string } = {},
): Promise<Profile> {
  const existing = await getProfile(db, userId);
  if (existing) return existing;

  const base = (fallback.username ?? `user-${userId.replace(/-/g, "").slice(0, 8)}`)
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "user";
  const username = base.length >= 2 ? base : `${base}-app`;

  const { data, error } = await db
    .from("profiles")
    .insert({ id: userId, username, display_name: fallback.displayName ?? null })
    .select("*")
    .single();
  if (error) {
    if (error.code === "23505") {
      const unique = `${base}-${userId.replace(/-/g, "").slice(0, 4)}`.slice(0, 40);
      const { data: retried, error: retryErr } = await db
        .from("profiles")
        .insert({ id: userId, username: unique, display_name: fallback.displayName ?? null })
        .select("*")
        .single();
      if (retryErr) throw new LemonAIdeError(ErrorCode.INTERNAL, "failed to create profile", { cause: retryErr });
      return retried as Profile;
    }
    throw new LemonAIdeError(ErrorCode.INTERNAL, "failed to create profile", { cause: error });
  }
  return data as Profile;
}

export async function recordAudit(
  db: SupabaseClient,
  entry: {
    userId?: string | null;
    actorType: "user" | "mcp" | "system" | "dashboard";
    action: string;
    targetType?: string;
    targetId?: string;
    meta?: Record<string, unknown>;
    correlationId?: string;
    ip?: string;
    userAgent?: string;
  },
): Promise<void> {
  const { error } = await db.from("audit_logs").insert({
    user_id: entry.userId ?? null,
    actor_type: entry.actorType === "dashboard" ? "user" : entry.actorType,
    action: entry.action,
    target_type: entry.targetType ?? null,
    target_id: entry.targetId ?? null,
    meta: entry.meta ?? {},
    correlation_id: entry.correlationId ?? null,
    ip: entry.ip ?? null,
    user_agent: entry.userAgent ?? null,
  });
  if (error) {
    // Auditing must never break the main flow, but failures are logged by callers via cause.
    console.warn(JSON.stringify({ level: "warn", msg: "audit insert failed", code: error.code }));
  }
}
