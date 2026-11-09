import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../env";
import {
  supabasePasswordGrant,
  supabaseSignupGrant,
  SupabaseAuthError,
} from "./supabase-upstream";

function fakeEnv(overrides: Partial<Env> = {}): Env {
  return {
    ENVIRONMENT: "development",
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_ANON_KEY: "anon",
    MCP_PUBLIC_URL: "https://lemonaide.example.com/",
    ...overrides,
  } as unknown as Env;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("supabasePasswordGrant", () => {
  it("posts the email/password grant to GoTrue with the anon key", async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => {
      return new Response(JSON.stringify({ access_token: "at", user: { id: "u1" } }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const session = await supabasePasswordGrant(fakeEnv(), "user@example.com", "hunter2");

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://example.supabase.co/auth/v1/token?grant_type=password");
    const headers = init.headers as Record<string, string>;
    expect(headers.apikey).toBe("anon");
    expect(JSON.parse(String(init.body))).toEqual({ email: "user@example.com", password: "hunter2" });
    expect(session.user.id).toBe("u1");
  });

  it("surfaces the GoTrue error message on failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ message: "Email not confirmed" }), { status: 400 })),
    );

    await expect(supabasePasswordGrant(fakeEnv(), "user@example.com", "bad")).rejects.toMatchObject({
      name: "SupabaseAuthError",
      message: "Email not confirmed",
    });
    await expect(supabasePasswordGrant(fakeEnv(), "u@e.com", "x")).rejects.toBeInstanceOf(SupabaseAuthError);
  });

  it("falls back to a generic message for non-JSON errors", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("oops", { status: 502 })));

    await expect(supabasePasswordGrant(fakeEnv(), "u@e.com", "x")).rejects.toMatchObject({
      message: "auth failed (502)",
    });
  });
});

describe("supabaseSignupGrant", () => {
  it("posts a signup and returns the session when autoconfirmed", async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => {
      return new Response(JSON.stringify({ access_token: "at", user: { id: "u2" } }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const session = await supabaseSignupGrant(fakeEnv(), "new@example.com", "hunter2");

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://example.supabase.co/auth/v1/signup");
    const headers = init.headers as Record<string, string>;
    expect(headers.apikey).toBe("anon");
    expect(JSON.parse(String(init.body))).toEqual({ email: "new@example.com", password: "hunter2" });
    expect(session.user.id).toBe("u2");
  });

  it("points the user at their inbox when the project still requires confirmation", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ user: { id: "u3" } }), { status: 200 })),
    );

    await expect(supabaseSignupGrant(fakeEnv(), "new@example.com", "hunter2")).rejects.toMatchObject({
      name: "SupabaseAuthError",
      message: "Account created — confirm the email via the link we sent, then connect again.",
    });
  });

  it("surfaces GoTrue messages like 'already registered'", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ msg: "User already registered" }), { status: 422 })),
    );

    await expect(supabaseSignupGrant(fakeEnv(), "dupe@example.com", "hunter2")).rejects.toMatchObject({
      message: "User already registered",
    });
  });
});
