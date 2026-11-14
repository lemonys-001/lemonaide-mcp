#!/usr/bin/env node
/**
 * Wipe production data: Supabase tables + auth users, OAuth grants (OAUTH_KV),
 * blobs and connect states (BLOB_STORE). Keeps ghapp:* keys (GitHub App config)
 * when KEEP_GITHUB_APP=true. Requires CONFIRM=RESET-PROD.
 *
 * Idempotent: safe to re-run.
 */
const SUPABASE_URL = required("SUPABASE_URL");
const SB_KEY = required("SUPABASE_SERVICE_ROLE_KEY");
const CF_TOKEN = required("CLOUDFLARE_API_TOKEN");
const CF_ACCOUNT = required("CLOUDFLARE_ACCOUNT_ID");
const KEEP_GITHUB_APP = (process.env.KEEP_GITHUB_APP ?? "true") === "true";

if (process.env.CONFIRM !== "RESET-PROD") {
  console.error("CONFIRM must be RESET-PROD — aborting.");
  process.exit(1);
}

const OAUTH_NS = "396cc35e40a84e57b5345650744174aa";
const BLOB_NS = "f16f9b8ff6f34ce0bfb4c79c0128172e";

function required(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`missing env ${name}`);
    process.exit(1);
  }
  return value;
}

const sbFetch = (path, init = {}) => fetch(`${SUPABASE_URL}${path}`, { ...init, headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, ...(init.headers ?? {}) } });
const cfFetch = (path, init = {}) => fetch(`https://api.cloudflare.com/client/v4${path}`, { ...init, headers: { Authorization: `Bearer ${CF_TOKEN}`, "Content-Type": "application/json", ...(init.headers ?? {}) } });

async function main() {
  console.log("== Supabase: wipe public tables ==");
  // Composite/bigint-keyed tables use their own non-uuid columns.
  const wipeTargets = [
    ["audit_logs", "id", "neq.00000000-0000-0000-0000-000000000000"],
    ["usage_records", "user_id", "neq.00000000-0000-0000-0000-000000000000"],
    ["mcp_authorizations", "id", "neq.00000000-0000-0000-0000-000000000000"],
    ["github_repositories", "id", "neq.00000000-0000-0000-0000-000000000000"],
    ["github_installations", "id", "neq.00000000-0000-0000-0000-000000000000"],
    ["deployments", "id", "neq.00000000-0000-0000-0000-000000000000"],
    ["builds", "id", "neq.00000000-0000-0000-0000-000000000000"],
    ["project_files", "path", "neq.__reset__"],
    ["project_versions", "id", "neq.00000000-0000-0000-0000-000000000000"],
    ["projects", "id", "neq.00000000-0000-0000-0000-000000000000"],
    ["profiles", "id", "neq.00000000-0000-0000-0000-000000000000"],
  ];
  for (const [table, column, filter] of wipeTargets) {
    const res = await sbFetch(`/rest/v1/${table}?${column}=${filter}`, { method: "DELETE" });
    console.log(`  ${table} -> ${res.status}`);
    if (res.status >= 300) console.log(`    ${await res.text().catch(() => "")}`);
  }

  console.log("== Supabase: delete auth users ==");
  for (let page = 1; page < 100; page++) {
    const res = await sbFetch(`/auth/v1/admin/users?per_page=100&page=${page}`);
    const body = await res.json();
    const users = body.users ?? [];
    if (users.length === 0) break;
    for (const user of users) {
      const del = await sbFetch(`/auth/v1/admin/users/${user.id}`, { method: "DELETE" });
      console.log(`  auth user ${user.id} -> ${del.status}`);
    }
  }

  await wipeKv(OAUTH_NS, "OAUTH_KV", "");
  await wipeKv(BLOB_NS, "BLOB_STORE", KEEP_GITHUB_APP ? "ghapp:" : "");
  console.log(`== Done — production data wiped${KEEP_GITHUB_APP ? " (ghapp:* kept)" : ""} ==`);
}

async function wipeKv(ns, label, keepPrefix) {
  console.log(`== KV: ${label} ==`);
  let cursor = "";
  let total = 0;
  do {
    const query = new URLSearchParams({ limit: "1000" });
    if (cursor) query.set("cursor", cursor);
    const res = await cfFetch(`/accounts/${CF_ACCOUNT}/storage/kv/namespaces/${ns}/keys?${query}`);
    const body = await res.json();
    if (!body.success) {
      console.error(`  ${label} list failed: ${JSON.stringify(body.errors ?? body)}`);
      process.exit(1);
    }
    const keys = (body.result ?? []).map((k) => k.name).filter((name) => !keepPrefix || !name.startsWith(keepPrefix));
    if (keys.length > 0) {
      const del = await cfFetch(`/accounts/${CF_ACCOUNT}/storage/kv/namespaces/${ns}/bulk`, { method: "POST", body: JSON.stringify(keys) });
      const delBody = await del.json();
      if (!delBody.success) {
        console.error(`  ${label} bulk delete failed: ${JSON.stringify(delBody.errors ?? delBody)}`);
        process.exit(1);
      }
      total += keys.length;
    }
    cursor = body.result_info?.cursor ?? "";
  } while (cursor);
  console.log(`  deleted ${total} keys${keepPrefix ? ` (kept ${keepPrefix}*)` : ""}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
