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

async function authErrorFromResponse(res: Response): Promise<SupabaseAuthError> {
  let message = `auth failed (${res.status})`;
  try {
    const body = (await res.json()) as {
      msg?: string;
      message?: string;
      error_description?: string;
      error?: string;
    };
    message = body.message || body.msg || body.error_description || body.error || message;
  } catch {
    // keep generic message
  }
  return new SupabaseAuthError(message);
}

async function parseSession(res: Response): Promise<SupabaseSession> {
  const session = (await res.json()) as SupabaseSession & { access_token?: string };
  if (!session.access_token) {
    throw new SupabaseAuthError(
      "Account created — confirm the email via the link we sent, then connect again.",
    );
  }
  return session;
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
    throw await authErrorFromResponse(res);
  }
  return (await res.json()) as SupabaseSession;
}

/**
 * Create the account when the user doesn't have one yet, so MCP clients can
 * onboard brand-new users. Requires autoconfirm (returns a session) — users on
 * confirmation-required projects get pointed at their inbox instead.
 */
export async function supabaseSignupGrant(
  env: Env,
  email: string,
  password: string,
): Promise<SupabaseSession> {
  const res = await fetch(`${env.SUPABASE_URL}/auth/v1/signup`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      apikey: env.SUPABASE_ANON_KEY,
    },
    body: JSON.stringify({ email, password }),
  });

  if (!res.ok) {
    throw await authErrorFromResponse(res);
  }
  return parseSession(res);
}
