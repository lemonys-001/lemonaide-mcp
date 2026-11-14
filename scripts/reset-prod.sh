#!/usr/bin/env bash
# Wipe production data: Supabase tables + auth users, OAuth grants (OAUTH_KV),
# blobs and connect states (BLOB_STORE). Keeps ghapp:* keys (GitHub App config)
# when KEEP_GITHUB_APP=true. Requires CONFIRM=RESET-PROD.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

[ "${CONFIRM:-}" = "RESET-PROD" ] || { echo "CONFIRM must be RESET-PROD — aborting."; exit 1; }
: "${SUPABASE_URL:?}"; : "${SUPABASE_SERVICE_ROLE_KEY:?}"; : "${CLOUDFLARE_ACCOUNT_ID:?}"; : "${CLOUDFLARE_API_TOKEN:?}"

OAUTH_NS="396cc35e40a84e57b5345650744174aa"
BLOB_NS="f16f9b8ff6f34ce0bfb4c79c0128172e"

cf() { curl -sf --retry 3 -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" "$@"; }

sb() { curl -sf --retry 3 -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" "$@"; }

echo "== Supabase: wipe public tables =="
for table in audit_logs usage_records mcp_authorizations github_repositories github_installations deployments builds project_files project_versions projects profiles; do
  # postgrest delete-all: neq on the uuid PK with a zero uuid
  res=$(sb -o /dev/null -w "%{http_code}" -X DELETE "$SUPABASE_URL/rest/v1/$table?id=neq.00000000-0000-0000-0000-000000000000" || true)
  echo "  $table -> $res"
done

echo "== Supabase: delete auth users =="
page=1
while :; do
  users=$(sb "$SUPABASE_URL/auth/v1/admin/users?per_page=100&page=$page")
  ids=$(printf '%s' "$users" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);console.log((j.users||[]).map(u=>u.id).join('\n'))})")
  [ -z "$ids" ] && break
  for id in $ids; do
    code=$(sb -o /dev/null -w "%{http_code}" -X DELETE "$SUPABASE_URL/auth/v1/admin/users/$id" || true)
    echo "  auth user $id -> $code"
  done
  page=$((page + 1))
done

wipe_kv() {
  local ns="$1" keep_prefix="$2" cursor="" keys page
  while :; do
    page=$(cf "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/storage/kv/namespaces/$ns/keys?limit=1000&cursor=$cursor")
    keys=$(printf '%s' "$page" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);const ks=(j.result||[]).map(k=>k.name).filter(n=>!process.argv[1]||!n.startsWith(process.argv[1]));console.log(JSON.stringify(ks))})" "$keep_prefix")
    n=$(printf '%s' "$keys" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).length))")
    if [ "$n" != "0" ]; then
      cf -X POST -H "Content-Type: application/json" -d "$keys" \
        "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/storage/kv/namespaces/$ns/bulk" >/dev/null
      echo "  ns $ns: deleted $n keys"
    fi
    next=$(printf '%s' "$page" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log((JSON.parse(d).result_info||{}).cursor||''))")
    [ -z "$next" ] && break
    cursor="$next"
  done
}

echo "== KV: OAUTH_KV (all grants) =="
wipe_kv "$OAUTH_NS" ""

echo "== KV: BLOB_STORE (files, artifacts, states) =="
if [ "${KEEP_GITHUB_APP:-true}" = "true" ]; then
  echo "  keeping ghapp:* keys"
  wipe_kv "$BLOB_NS" "ghapp:"
else
  wipe_kv "$BLOB_NS" ""
fi

echo "== Done — production data wiped =="
