/**
 * OAuth authorize endpoints served by the defaultHandler:
 *
 *   GET  /authorize      → consent page (workers-oauth-provider helpers)
 *   POST /authorize      → approve + redirect to Supabase /auth/v1/authorize
 *   GET  /oauth/callback → Supabase PKCE callback → completeAuthorization
 *
 * Supabase is the upstream IdP; LemonAIde remains the authorization server
 * for MCP clients (confused-deputy protections via beginConsent/beginUpstream).
 */

import { AuthorizationError, authorizationErrorRedirect } from "@cloudflare/workers-oauth-provider";
import { exchangeSupabaseCode, supabaseAuthorizeUrl } from "./supabase-upstream";
import type { Env } from "../env";
import { isProduction } from "../env";
import { getSupabaseServiceClient } from "../db/supabase";
import { ensureProfile, recordAudit } from "../db/profiles";
import { escapeHtml, htmlPage } from "../lib/http";

/** Helpers object injected by OAuthProvider on env for defaultHandler/apiHandler. */
interface OAuthHelpersLike {
  parseAuthRequest(request: Request): Promise<AuthRequestLike>;
  lookupClient(clientId: string): Promise<ClientInfoLike | null>;
  describeConsent(authRequest: AuthRequestLike): Promise<ConsentDescriptionLike>;
  beginConsent(authRequest: AuthRequestLike): Promise<{ handle: string; headers: Headers }>;
  approveConsent(
    request: Request,
    handle: string,
    options?: { scope?: string[]; remember?: { secret: string; subject?: string } },
  ): Promise<{ request: AuthRequestLike; headers: Headers }>;
  beginUpstream(
    authRequest: AuthRequestLike,
    options?: { data?: unknown; headers?: Headers },
  ): Promise<{ state: string; headers: Headers }>;
  finishUpstream<Data = unknown>(request: Request): Promise<{ request: AuthRequestLike; data: Data; headers: Headers }>;
  completeAuthorization(options: {
    request: AuthRequestLike;
    userId: string;
    metadata?: Record<string, unknown>;
    scope?: string[];
    props?: Record<string, unknown>;
  }): Promise<{ redirectTo: string }>;
  listUserGrants(
    userId: string,
    options?: { limit?: number; cursor?: string },
  ): Promise<{ items: { id: string; clientId: string; scope: string[] }[]; nextCursor?: string }>;
}

interface AuthRequestLike {
  clientId: string;
  redirectUri: string;
  scope: string[];
  state?: string;
  [key: string]: unknown;
}

interface ClientInfoLike {
  clientId: string;
  clientName?: string;
  [key: string]: unknown;
}

interface ConsentDescriptionLike {
  clientName: string;
  redirectHost: string;
  scopes: string[];
  [key: string]: unknown;
}

function helpers(env: Env): OAuthHelpersLike {
  const provider = (env as { OAUTH_PROVIDER?: OAuthHelpersLike }).OAUTH_PROVIDER;
  if (!provider) throw new Error("OAUTH_PROVIDER binding missing — route through OAuthProvider");
  return provider;
}

const SCOPE_BLURB: Record<string, { title: string; blurb: string }> = {
  "mcp:read": { title: "Read your projects", blurb: "List projects, files, builds and deployments" },
  "mcp:write": { title: "Create and change things", blurb: "Create projects, edit files, build, deploy, delete" },
  offline_access: { title: "Stay signed in", blurb: "Keep access working without re-authorizing every session" },
};

export async function handleAuthorizeGet(request: Request, env: Env): Promise<Response> {
  const oauth = helpers(env);
  let authRequest: AuthRequestLike;
  try {
    authRequest = await oauth.parseAuthRequest(request);
  } catch (err) {
    if (err instanceof AuthorizationError && "redirectTo" in err && err.redirectTo) {
      return Response.redirect(err.redirectTo as string, 302);
    }
    return htmlPage(
      "Sign-in error",
      `<div class="brand">LemonAIde</div><h1>Sign-in could not start</h1><p>${escapeHtml(
        err instanceof Error ? err.message : String(err),
      )}</p>`,
      400,
    );
  }

  const client = await oauth.lookupClient(authRequest.clientId);
  const consent = await oauth.describeConsent(authRequest);
  const { handle, headers: consentHeaders } = await beginConsentOnce(oauth, authRequest);

  const requested = new Set(authRequest.scope ?? []);
  const known = (consent.scopes ?? authRequest.scope ?? []).filter((s) => s in SCOPE_BLURB || requested.has(s));
  const scopeRows = (known.length ? known : [...requested]).map((scope) => {
    const info = SCOPE_BLURB[scope] ?? { title: scope, blurb: "Platform access" };
    return `<label style="display:flex;gap:10px;align-items:flex-start;padding:10px 0;border-top:1px solid var(--line)">
      <input type="checkbox" name="scope" value="${escapeHtml(scope)}" checked style="margin-top:3px">
      <span><strong>${escapeHtml(info.title)}</strong><br><span style="color:var(--muted);font-size:13px">${escapeHtml(info.blurb)} · <code>${escapeHtml(scope)}</code></span></span>
    </label>`;
  }).join("");

  const localhost = authRequest.redirectUri.startsWith("http://localhost") || authRequest.redirectUri.startsWith("http://127.0.0.1");
  const devSkip =
    !isProduction(env) && env.DEV_FAKE_AUTH
      ? `<button class="ghost" name="dev_skip" value="1" formnovalidate>Dev: skip Supabase (${escapeHtml(env.DEV_FAKE_AUTH)})</button>`
      : "";

  const body = `<div class="brand">LemonAIde</div>
<h1>Connect ${escapeHtml(consent.clientName ?? client?.clientName ?? authRequest.clientId)}</h1>
<p><strong>${escapeHtml(consent.clientName ?? authRequest.clientId)}</strong> wants to use your LemonAIde account to build and publish web apps.</p>
<p>It will be sent back to <code>${escapeHtml(consent.redirectHost)}</code> after you approve.</p>
${localhost ? `<p class="warn">This redirect goes to localhost — a local app on this machine.</p>` : ""}
<form method="post" action="/authorize" style="flex-direction:column;align-items:stretch;gap:14px">
  <input type="hidden" name="handle" value="${escapeHtml(handle)}">
  <div class="scopes">${scopeRows || "<em>No scopes requested</em>"}</div>
  <label style="display:flex;gap:8px;align-items:center;font-size:13px;color:var(--muted)">
    <input type="checkbox" name="remember" value="1" checked> Don't ask again for this client
  </label>
  <div style="display:flex;gap:10px">
    <button class="primary" type="submit" name="approve" value="1">Continue with Supabase</button>
    ${devSkip}
    <button class="ghost" type="submit" name="deny" value="1" formnovalidate>Cancel</button>
  </div>
</form>`;

  const page = htmlPage("Authorize", body);
  const merged = new Headers(page.headers);
  consentHeaders.forEach((v, k) => merged.set(k, v));
  return new Response(page.body, { status: 200, headers: merged });
}

// beginConsent is single-use per handle; cache per request invocation.
const consentCache = new WeakMap<AuthRequestLike, { handle: string; headers: Headers }>();
async function beginConsentOnce(
  oauth: OAuthHelpersLike,
  authRequest: AuthRequestLike,
): Promise<{ handle: string; headers: Headers }> {
  let entry = consentCache.get(authRequest);
  if (!entry) {
    entry = await oauth.beginConsent(authRequest);
    consentCache.set(authRequest, entry);
  }
  return entry;
}

export async function handleAuthorizePost(request: Request, env: Env): Promise<Response> {
  const oauth = helpers(env);
  const form = await request.formData();
  const handle = String(form.get("handle") ?? "");

  try {
    if (form.get("deny")) {
      // consume handle via approve path alternative: denyConsent
      const denied = await (
        oauth as unknown as {
          denyConsent(request: Request, handle: string): Promise<{ redirectTo: string; headers: Headers }>;
        }
      ).denyConsent(request, handle);
      const headers = new Headers(denied.headers);
      headers.set("Location", denied.redirectTo);
      return new Response(null, { status: 302, headers });
    }

    const scope = form.getAll("scope").map(String).filter(Boolean);
    const remember = form.get("remember")
      ? { secret: env.CONSENT_SECRET ?? env.SESSION_SECRET ?? "lemonaide-dev-consent" }
      : undefined;
    const approved = await oauth.approveConsent(request, handle, { scope: scope.length ? scope : undefined, remember });

    // Development shortcut: complete authorization without Supabase.
    if (form.get("dev_skip") && !isProduction(env) && env.DEV_FAKE_AUTH) {
      const db = getSupabaseServiceClient(env);
      const profile = await ensureProfile(db, env.DEV_FAKE_AUTH, { username: env.DEV_FAKE_AUTH });
      const { redirectTo } = await oauth.completeAuthorization({
        request: approved.request,
        userId: profile.id,
        scope: approved.request.scope,
        props: { userId: profile.id, username: profile.username },
      });
      const headers = new Headers(approved.headers);
      headers.set("Location", redirectTo);
      return new Response(null, { status: 302, headers });
    }

    const verifier = crypto.randomUUID() + crypto.randomUUID();
    const { headers } = await oauth.beginUpstream(approved.request, {
      data: { verifier },
      headers: approved.headers,
    });
    headers.set("Location", await supabaseAuthorizeUrl(env, approved.request, verifier));
    return new Response(null, { status: 302, headers });
  } catch (err) {
    if (err instanceof AuthorizationError && err.redirectTo) {
      return Response.redirect(err.redirectTo, 302);
    }
    if (err instanceof AuthorizationError) {
      return htmlPage("Authorization error", `<h1>Authorization failed</h1><p>${escapeHtml(err.message)}</p>`, 400);
    }
    throw err;
  }
}

export async function handleOauthCallback(request: Request, env: Env): Promise<Response> {
  const oauth = helpers(env);
  const url = new URL(request.url);

  let resumed: { request: AuthRequestLike; data: { verifier: string }; headers: Headers };
  try {
    resumed = await oauth.finishUpstream<{ verifier: string }>(request);
  } catch (err) {
    if (err instanceof AuthorizationError && err.redirectTo) {
      return Response.redirect(err.redirectTo, 302);
    }
    return htmlPage("Sign-in error", `<h1>Sign-in failed</h1><p>${escapeHtml(err instanceof Error ? err.message : String(err))}</p>`, 400);
  }

  if (url.searchParams.get("error")) {
    const headers = new Headers(resumed.headers);
    headers.set(
      "Location",
      authorizationErrorRedirect(resumed.request, "access_denied", url.searchParams.get("error_description") ?? undefined),
    );
    return new Response(null, { status: 302, headers });
  }

  const code = url.searchParams.get("code");
  if (!code) {
    const headers = new Headers(resumed.headers);
    headers.set("Location", authorizationErrorRedirect(resumed.request, "server_error", "missing code"));
    return new Response(null, { status: 302, headers });
  }

  try {
    const session = await exchangeSupabaseCode(env, code, resumed.data.verifier);
    const db = getSupabaseServiceClient(env);
    const meta = session.user.user_metadata as Record<string, unknown> | undefined;
    const profile = await ensureProfile(db, session.user.id, {
      username: (meta?.username as string | undefined) ?? session.user.email?.split("@")[0],
      displayName: (meta?.display_name as string | undefined) ?? (meta?.full_name as string | undefined),
    });

    // Keep our grant's refresh working: store the upstream refresh token.
    const { redirectTo } = await oauth.completeAuthorization({
      request: resumed.request,
      userId: profile.id,
      scope: resumed.request.scope,
      props: {
        userId: profile.id,
        username: profile.username,
        supabaseRefreshToken: session.refresh_token ?? null,
      },
    });

    // Record the connection for the dashboard's "connections" list.
    try {
      const grants = await oauth.listUserGrants(profile.id, { limit: 100 });
      const match = grants.items.find((g) => g.clientId === resumed.request.clientId);
      if (match) {
        const { insertMcpAuthorization } = await import("../db/repos");
        const client = await oauth.lookupClient(resumed.request.clientId).catch(() => null);
        await insertMcpAuthorization(db, {
          userId: profile.id,
          clientId: resumed.request.clientId,
          clientName: (client as { clientName?: string } | null)?.clientName,
          scopes: resumed.request.scope,
          grantId: match.id,
        });
      }
    } catch (err) {
      console.warn(JSON.stringify({ level: "warn", msg: "failed to record mcp authorization", err: err instanceof Error ? err.message : String(err) }));
    }

    await recordAudit(db, {
      userId: profile.id,
      actorType: "mcp",
      action: "auth.authorize",
      targetType: "grant",
      targetId: resumed.request.clientId,
      meta: { scopes: resumed.request.scope },
    }).catch(() => undefined);

    const headers = new Headers(resumed.headers);
    headers.set("Location", redirectTo);
    return new Response(null, { status: 302, headers });
  } catch (err) {
    console.error(JSON.stringify({ level: "error", msg: "supabase code exchange failed", err: err instanceof Error ? err.message : String(err) }));
    const headers = new Headers(resumed.headers);
    headers.set("Location", authorizationErrorRedirect(resumed.request, "server_error", "upstream sign-in failed"));
    return new Response(null, { status: 302, headers });
  }
}

/* ------------------------------------------------------------------ */
/* Supabase upstream (imported from the pure helper module)            */
/* ------------------------------------------------------------------ */

