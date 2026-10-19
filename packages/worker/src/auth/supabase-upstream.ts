/**
 * Supabase-as-upstream-IdP helpers: authorize URL (PKCE S256) + code exchange.
 * Pure Web Crypto / fetch — deliberately free of workers-oauth-provider imports
 * so this module is unit-testable outside the Workers runtime.
 */

import type { Env } from "../env";

export interface SupabaseTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token?: string;
  user: {
    id: string;
    email?: string;
    user_metadata?: Record<string, unknown>;
  };
}

export async function supabaseAuthorizeUrl(env: Env, _authRequest: unknown, verifier: string): Promise<string> {
  const callback = callbackUrl(env);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  const challenge = b64url(new Uint8Array(digest));
  const params = new URLSearchParams({
    redirect_to: callback,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  return `${env.SUPABASE_URL}/auth/v1/authorize?${params.toString()}`;
}

export function b64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function callbackUrl(env: Env): string {
  const base = env.MCP_PUBLIC_URL.replace(/\/+$/, "");
  return `${base}/oauth/callback`;
}

export async function exchangeSupabaseCode(
  env: Env,
  code: string,
  verifier: string,
): Promise<SupabaseTokenResponse> {
  const res = await fetch(`${env.SUPABASE_URL}/auth/v1/token?grant_type=authorization_code`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      apikey: env.SUPABASE_ANON_KEY,
    },
    body: JSON.stringify({ code, code_verifier: verifier }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`supabase token exchange ${res.status}: ${text.slice(0, 200)}`);
  }
  return (await res.json()) as SupabaseTokenResponse;
}
