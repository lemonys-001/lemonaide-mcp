import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Env } from "../env";

const clients = new Map<string, SupabaseClient>();

/**
 * Service-role client. Bypasses RLS — every caller MUST enforce ownership
 * explicitly (repositories in db/repos do this by scoping on owner ids).
 * Never expose this client or its key outside the Worker.
 */
export function getSupabaseServiceClient(env: Env): SupabaseClient {
  const key = `${env.SUPABASE_URL}|service`;
  let client = clients.get(key);
  if (!client) {
    client = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { headers: { "x-lemonaide": "worker" } },
    });
    clients.set(key, client);
  }
  return client;
}

export function isUniqueViolation(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  return code === "23505";
}
