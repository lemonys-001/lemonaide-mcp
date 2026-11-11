/**
 * MCP authorization page served by the defaultHandler:
 *
 *   GET  /authorize → consent + sign-in page (single form: scopes, email, password)
 *   POST /authorize → approve + Supabase password grant → completeAuthorization
 *
 * The user signs in with the same email/password accounts the dashboard uses.
 * There is no separate upstream OAuth hop: workers-oauth-provider remains the
 * authorization server; Supabase verifies the password and owns the profile.
 */

import { AuthorizationError } from "@cloudflare/workers-oauth-provider";
import {
  SupabaseAuthError,
  supabasePasswordGrant,
  supabaseSignupGrant,
  type SupabaseSession,
} from "./supabase-upstream";
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
  beginUpstream?(
    authRequest: AuthRequestLike,
    options?: { data?: unknown; headers?: Headers },
  ): Promise<{ state: string; headers: Headers }>;
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
  scope: string[];
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
  const { handle, headers: consentHeaders } = await oauth.beginConsent(authRequest);

  const requested = new Set(authRequest.scope ?? []);
  const known = (consent.scope ?? authRequest.scope ?? []).filter((s) => s in SCOPE_BLURB || requested.has(s));
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
      ? `<button class="ghost" name="dev_skip" value="1" formnovalidate>Dev: skip sign-in (${escapeHtml(env.DEV_FAKE_AUTH)})</button>`
      : "";

  const body = `<div class="brand">LemonAIde</div>
<h1>Connect ${escapeHtml(consent.clientName ?? client?.clientName ?? authRequest.clientId)}</h1>
<p><strong>${escapeHtml(consent.clientName ?? authRequest.clientId)}</strong> wants to use your LemonAIde account to build and publish web apps.</p>
<p>It will be sent back to <code>${escapeHtml(consent.redirectHost)}</code> after you approve.</p>
${localhost ? `<p class="warn">This redirect goes to localhost — a local app on this machine.</p>` : ""}
<form method="post" action="/authorize" style="flex-direction:column;align-items:stretch;gap:14px">
  <input type="hidden" name="handle" value="${escapeHtml(handle)}">
  <div class="scopes">${scopeRows || "<em>No scopes requested</em>"}</div>
  <label style="display:block;font-size:13px;color:var(--muted)">Email
    <input type="email" name="email" required autocomplete="email" style="margin-top:6px">
  </label>
  <label style="display:block;font-size:13px;color:var(--muted)">Password
    <input type="password" name="password" required autocomplete="current-password" style="margin-top:6px">
  </label>
  <div style="display:flex;gap:10px">
    <button class="primary" type="submit" name="approve" value="1">Sign in and connect</button>
    ${devSkip}
    <button class="ghost" type="submit" name="deny" value="1" formnovalidate>Cancel</button>
  </div>
</form>
<script>
(function () {
  var form = document.querySelector("form[action='/authorize']");
  if (!form) return;
  var supabaseRef = ${JSON.stringify(new URL(env.SUPABASE_URL).hostname.split(".")[0])};
  form.addEventListener("submit", function (ev) {
    var deny = form.querySelector("button[name='deny']");
    if (deny && ev.submitter === deny) return;
    ev.preventDefault();
    var email = form.querySelector("input[name='email']").value.trim();
    var password = form.querySelector("input[name='password']").value;
    var finish = function () { form.submit(); };
    var boot = fetch("/api/auth/session-bootstrap", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: email, password: password }),
    })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (payload) {
        if (!payload || !payload.data || !payload.data.access_token) return;
        var s = payload.data;
        localStorage.setItem(
          "sb-" + supabaseRef + "-auth-token",
          JSON.stringify({
            access_token: s.access_token,
            refresh_token: s.refresh_token,
            token_type: "bearer",
            expires_in: s.expires_in,
            expires_at: Math.floor(Date.now() / 1000) + (s.expires_in || 3600),
            user: s.user,
          }),
        );
      })
      .catch(function () {});
    Promise.race([boot, new Promise(function (r) { setTimeout(r, 2500); })]).then(finish);
  });
})();
</script>`;

  const page = htmlPage("Authorize", body);
  const merged = new Headers(page.headers);
  consentHeaders.forEach((v, k) => merged.set(k, v));
  return new Response(page.body, { status: 200, headers: merged });
}

export async function handleAuthorizePost(request: Request, env: Env): Promise<Response> {
  const oauth = helpers(env);
  const form = await request.formData();
  const handle = String(form.get("handle") ?? "");

  const renderError = (title: string, message: string, status = 400) =>
    htmlPage(title, `<div class="brand">LemonAIde</div><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>`, status);

  try {
    if (form.get("deny")) {
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
    const approved = await oauth.approveConsent(request, handle, { scope: scope.length ? scope : undefined });

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

    const email = String(form.get("email") ?? "").trim();
    const password = String(form.get("password") ?? "");
    if (!email || !password) {
      return renderError("Sign-in required", "Email and password are required to connect.");
    }

    let session: SupabaseSession;
    try {
      session = await supabasePasswordGrant(env, email, password);
    } catch {
      // No account yet? Migrate-onboarding path: create it, then continue.
      try {
        session = await supabaseSignupGrant(env, email, password);
      } catch (signupErr) {
        return renderError(
          "Sign-in failed",
          signupErr instanceof SupabaseAuthError
            ? signupErr.message
            : "Email or password is incorrect. Create your account on the dashboard first if needed.",
        );
      }
    }
    const db = getSupabaseServiceClient(env);
    const meta = session.user.user_metadata as Record<string, unknown> | undefined;
    const profile = await ensureProfile(db, session.user.id, {
      username: (meta?.username as string | undefined) ?? session.user.email?.split("@")[0],
      displayName: (meta?.display_name as string | undefined) ?? (meta?.full_name as string | undefined),
    });

    // Store the upstream refresh token so tokenExchangeCallback can keep the
    // grant alive when the MCP client's access token expires.
    const { redirectTo } = await oauth.completeAuthorization({
      request: approved.request,
      userId: profile.id,
      scope: approved.request.scope,
      props: {
        userId: profile.id,
        username: profile.username,
        supabaseRefreshToken: session.refresh_token ?? null,
      },
    });

    // Record the connection for the dashboard's "connections" list.
    try {
      const grants = await oauth.listUserGrants(profile.id, { limit: 100 });
      const match = grants.items.find((g) => g.clientId === approved.request.clientId);
      if (match) {
        const { insertMcpAuthorization } = await import("../db/repos");
        const client = await oauth.lookupClient(approved.request.clientId).catch(() => null);
        await insertMcpAuthorization(db, {
          userId: profile.id,
          clientId: approved.request.clientId,
          clientName: (client as { clientName?: string } | null)?.clientName,
          scopes: approved.request.scope,
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
      targetId: approved.request.clientId,
      meta: { scopes: approved.request.scope },
    }).catch(() => undefined);

    const headers = new Headers(approved.headers);
    headers.set("Location", redirectTo);
    return new Response(null, { status: 302, headers });
  } catch (err) {
    if (err instanceof AuthorizationError && err.redirectTo) {
      return Response.redirect(err.redirectTo, 302);
    }
    if (err instanceof AuthorizationError) {
      return renderError("Authorization error", err.message);
    }
    if (err instanceof SupabaseAuthError) {
      return renderError("Sign-in failed", err.message);
    }
    throw err;
  }
}
