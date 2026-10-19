import { describe, expect, it } from "vitest";
import type { Env } from "../env";
import { supabaseAuthorizeUrl } from "./supabase-upstream";

function fakeEnv(overrides: Partial<Env> = {}): Env {
  return {
    ENVIRONMENT: "development",
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_ANON_KEY: "anon",
    MCP_PUBLIC_URL: "https://lemonaide.example.com/",
    ...overrides,
  } as unknown as Env;
}

describe("__supabaseAuthorizeUrlForTests", () => {
  it("builds the Supabase authorize URL with an S256 challenge", async () => {
    const url = new URL(await supabaseAuthorizeUrl(fakeEnv(), {} as never, "verifier-abc"));
    expect(url.origin).toBe("https://example.supabase.co");
    expect(url.pathname).toBe("/auth/v1/authorize");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    // challenge must be base64url(sha256(verifier)) — recompute independently
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("verifier-abc"));
    const expected = btoa(String.fromCharCode(...new Uint8Array(digest)))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    expect(url.searchParams.get("code_challenge")).toBe(expected);
  });

  it("sends the platform oauth callback as redirect_to (trailing slash trimmed)", async () => {
    const url = new URL(await supabaseAuthorizeUrl(fakeEnv(), {} as never, "v"));
    expect(url.searchParams.get("redirect_to")).toBe("https://lemonaide.example.com/oauth/callback");
  });
});
