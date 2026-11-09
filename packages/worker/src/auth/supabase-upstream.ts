/**
 * Supabase auth helpers for the MCP consent flow.
 *
 * Pure fetch-based calls; deliberately free of workers-oauth-provider imports
 * so this module is unit-testable outside the Workers runtime.
 */

import type { Env } from "../env";

export interface SupabaseSession {
  access_token: string;
  refresh_token?: string;
  user: {
    id: string;
    email?: string;
    user_metadata?: Record<string, unknown>;
  };
}

export class SupabaseAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SupabaseAuthError";
  }
}

/**
 * Sign in with email + password (GoTrue password grant).
 * Any Supabase project works — no OAuth provider configuration required.
 */
export async function supabasePasswordGrant(
  env: Env,
  email: string,
  password: string,
): Promise<SupabaseSession> {
  const res = await fetch(`${env.SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      apikey: env.SUPABASE_ANON_KEY,
    },
    body: JSON.stringify({ email, password }),
  });

  if (!res.ok) {
    let message = `sign-in failed (${res.status})`;
    try {
      const body = (await res.json()) as { msg?: string; message?: string; error_description?: string; error?: string };
      message = body.message || body.msg || body.error_description || body.error || message;
    } catch {
      // keep generic message
    }
    throw new SupabaseAuthError(message);
  }
  return (await res.json()) as SupabaseSession;
}
