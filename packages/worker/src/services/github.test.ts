import { describe, expect, it } from "vitest";
import type { Env } from "../env";
import { connectUrl, readConnectState, signConnectState, verifyConnectState } from "./github";

function fakeEnv(overrides: Partial<Env> = {}): Env {
  return {
    ENVIRONMENT: "development",
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_ANON_KEY: "anon",
    SUPABASE_SERVICE_ROLE_KEY: "service",
    MCP_PUBLIC_URL: "https://lemonaide.example.com",
    APP_BASE_DOMAIN: "lemonaide.example.com",
    SESSION_SECRET: "test-session-secret-0123456789",
    GITHUB_APP_SLUG: "lemonaide-test",
    ...overrides,
  } as unknown as Env;
}

describe("connect state HMAC", () => {
  it("round-trips and recovers the bound user id", async () => {
    const env = fakeEnv();
    const state = await signConnectState(env, "user-1");
    expect(await readConnectState(env, state)).toBe("user-1");
    expect(await verifyConnectState(env, state, "user-1")).toBe(true);
  });

  it("rejects a state presented for a different user", async () => {
    const env = fakeEnv();
    const state = await signConnectState(env, "user-1");
    expect(await verifyConnectState(env, state, "user-2")).toBe(false);
  });

  it("rejects tampered payloads", async () => {
    const env = fakeEnv();
    const state = await signConnectState(env, "user-1");
    // Flip a middle character: the last base64url char can be non-canonical
    // (trailing unused bits), so a last-char flip may decode to the same bytes.
    const at = 3;
    const flip = state.slice(0, at) + (state[at] === "A" ? "B" : "A") + state.slice(at + 1);
    expect(flip).not.toBe(state);
    expect(await readConnectState(env, flip)).toBeNull();
  });

  it("rejects garbage and empty states", async () => {
    const env = fakeEnv();
    expect(await readConnectState(env, "not-a-state")).toBeNull();
    expect(await readConnectState(env, "")).toBeNull();
    expect(await readConnectState(env, "aGVsbG8=")).toBeNull();
  });

  it("rejects expired states", async () => {
    const env = fakeEnv();
    const state = await signConnectState(env, "user-1", -1000);
    expect(await readConnectState(env, state)).toBeNull();
  });

  it("rejects states signed with a different secret", async () => {
    const env = fakeEnv();
    const other = fakeEnv({ SESSION_SECRET: "a-completely-different-secret" } as Partial<Env>);
    const state = await signConnectState(env, "user-1");
    expect(await readConnectState(other, state)).toBeNull();
  });
});

describe("connectUrl", () => {
  it("points at the GitHub App installation page when app config is present", async () => {
    const env = fakeEnv({ GITHUB_APP_ID: "1", GITHUB_APP_PRIVATE_KEY: "pem" } as Partial<Env>);
    expect(await connectUrl(env)).toBe("https://github.com/apps/lemonaide-test/installations/new");
  });

  it("throws NOT_CONFIGURED without app config", async () => {
    await expect(connectUrl(fakeEnv())).rejects.toThrow(/not configured/i);
  });
});
