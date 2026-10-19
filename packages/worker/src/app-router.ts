/**
 * Published-app router: serves live deployments at /{username}/{slug}/*.
 *
 *  - Assets come from the promoted deployment's artifact prefix (Workers KV).
 *  - Vite builds get SPA fallback to index.html; static sites 404.
 *  - HTML is never cached immutably; content-hashed assets are.
 */

import type { Env } from "./env";
import { getSupabaseServiceClient } from "./db/supabase";
import { lookupLiveDeployment } from "./db/repos";
import { contentTypeFor, getArtifact } from "./storage/source";
import { htmlPage } from "./lib/http";

const SPA_FRAMEWORKS = new Set(["vite-react-ts", "vite-vanilla"]);
const HASHED_ASSET_RE = /[.-][A-Za-z0-9_-]{8,}\.[a-z0-9]+$/;

export async function servePublishedApp(request: Request, env: Env, username: string, slug: string, restPath: string): Promise<Response> {
  if (!env.SUPABASE_URL) {
    return htmlPage(
      "Temporarily unavailable",
      `<div class="brand">LemonAIde</div>
<h1>Temporarily unavailable</h1>
<p>This platform is not fully configured yet (missing Supabase credentials).</p>`,
      503,
    );
  }
  const db = getSupabaseServiceClient(env);
  const found = await lookupLiveDeployment(db, username, slug);

  if (!found) {
    return notFoundPage(username, slug, "This app is not published (or the address is wrong).");
  }

  const { deployment } = found;
  const path = normalizeRequestPath(restPath);

  // Framework decides SPA fallback vs strict 404s.
  let isSpa = false;
  if (deployment.build_id) {
    const { data: buildRow } = await db.from("builds").select("framework").eq("id", deployment.build_id).maybeSingle();
    isSpa = SPA_FRAMEWORKS.has((buildRow?.framework as string) ?? "");
  }

  let key = path === "" ? "index.html" : path;
  let obj = await getArtifact(env.BLOB_STORE, deployment.asset_prefix, key);

  if (!obj && (key === "" || key.endsWith("/"))) {
    obj = await getArtifact(env.BLOB_STORE, deployment.asset_prefix, `${key}index.html`);
    key = obj ? `${key}index.html` : key;
  }

  // SPA fallback: unknown routes serve the app shell.
  if (!obj && isSpa && !path.includes(".")) {
    obj = await getArtifact(env.BLOB_STORE, deployment.asset_prefix, "index.html");
    key = "index.html";
  }

  if (!obj) {
    if (isSpa) {
      // SPA with a missing entry: still try the root shell.
      obj = await getArtifact(env.BLOB_STORE, deployment.asset_prefix, "index.html");
      key = "index.html";
    }
    if (!obj) return notFoundPage(username, slug, "This app has no page at that address.");
  }

  const contentType = contentTypeFor(key);
  const hashed = HASHED_ASSET_RE.test(key) && key !== "index.html";
  const cacheControl = hashed ? "public, max-age=31536000, immutable" : "public, no-cache, must-revalidate";

  const headers = new Headers({
    "content-type": contentType,
    "cache-control": cacheControl,
    "x-content-type-options": "nosniff",
    "referrer-policy": "strict-origin-when-cross-origin",
    "x-lemonaide-app": `${username}/${slug}`,
  });
  if (deployment.build_id) headers.set("x-lemonaide-build", deployment.build_id);

  return new Response(obj.bytes, { headers });
}

export function normalizeRequestPath(restPath: string): string {
  let path = restPath.replace(/^\/+/, "");
  try {
    path = decodeURIComponent(path);
  } catch {
    // keep raw
  }
  path = path.replace(/\\/g, "/");
  const segments = path.split("/");
  const safe: string[] = [];
  for (const segment of segments) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      safe.pop();
      continue;
    }
    safe.push(segment);
  }
  return safe.join("/");
}

function notFoundPage(username: string, slug: string, message: string): Response {
  return htmlPage(
    "Not found",
    `<div class="brand">LemonAIde</div>
<h1>Not found</h1>
<p>${message.replace(/[<>&]/g, (ch) => `&#${ch.charCodeAt(0)};`)}</p>
<p><code>/${escape(username)}/${escape(slug)}</code></p>
<p style="margin-top:18px"><a href="/" style="color:var(--accent)">← LemonAIde home</a></p>`,
    404,
  );
}

function escape(value: string): string {
  return value.replace(/[<>&"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

export function isReservedTopLevel(segment: string): boolean {
  return (
    segment === "api" ||
    segment === "mcp" ||
    segment === "authorize" ||
    segment === "oauth" ||
    segment === "callback" ||
    segment === "assets" ||
    segment === "favicon.ico" ||
    segment === "robots.txt" ||
    segment.startsWith(".")
  );
}
