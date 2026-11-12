/**
 * Account deletion: wipes every DB row the user owns (FK-safe order), revokes
 * their MCP grants in the provider KV, then deletes the Supabase auth user.
 * auth.users → profiles cascades, but we delete explicitly so a partial
 * cascade (deployments.build_id restrict) can never leave rows behind.
 * KV blobs (src/, build artifacts) are left as harmless orphans.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { ErrorCode, LemonAIdeError } from "@lemonaide/shared";
import type { Env } from "../env";

interface ProviderEnv {
  OAUTH_PROVIDER?: {
    listUserGrants(userId: string, opts?: { limit?: number }): Promise<{ items: { id: string }[] }>;
    revokeGrant(grantId: string, userId: string): Promise<void>;
  };
}

export async function deleteAccount(env: Env, db: SupabaseClient, userId: string): Promise<void> {
  const { data: projects } = await db.from("projects").select("id").eq("owner_id", userId);
  const projectIds = (projects ?? []).map((p) => p.id);

  if (projectIds.length > 0) {
    for (const table of ["deployments", "builds", "project_versions", "project_files"]) {
      const { error } = await db.from(table).delete().in("project_id", projectIds);
      if (error) throw new LemonAIdeError(ErrorCode.INTERNAL, `failed to delete ${table}`, { cause: error });
    }
    const { error } = await db.from("projects").delete().in("id", projectIds);
    if (error) throw new LemonAIdeError(ErrorCode.INTERNAL, "failed to delete projects", { cause: error });
  }

  for (const table of ["mcp_authorizations", "usage_records", "audit_logs", "profiles"]) {
    const { error } = await db.from(table).delete().eq("user_id", userId);
    if (error) throw new LemonAIdeError(ErrorCode.INTERNAL, `failed to delete ${table}`, { cause: error });
  }

  try {
    const provider = (env as unknown as ProviderEnv).OAUTH_PROVIDER;
    if (provider) {
      const grants = await provider.listUserGrants(userId, { limit: 100 });
      for (const grant of grants.items) {
        await provider.revokeGrant(grant.id, userId).catch(() => undefined);
      }
    }
  } catch {
    // KV revocation must not block the row cleanup — auth user delete invalidates tokens anyway.
  }

  const res = await fetch(`${env.SUPABASE_URL}/auth/v1/admin/users/${userId}`, {
    method: "DELETE",
    headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` },
  });
  if (!res.ok && res.status !== 404) {
    throw new LemonAIdeError(ErrorCode.INTERNAL, `failed to delete auth user (${res.status})`);
  }
}
