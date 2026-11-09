#!/usr/bin/env bash
# Upload Cloudflare Worker secrets from environment variables.
# Each NAME=value pair above is pushed with `wrangler secret put`; empty values
# are skipped so optional integrations (GitHub App, PAT) stay untouched.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../packages/worker"

names=(
  SUPABASE_URL
  SUPABASE_ANON_KEY
  SUPABASE_SERVICE_ROLE_KEY
  SESSION_SECRET
  BUILD_RUNNER_TOKEN
  GITHUB_APP_ID
  GITHUB_APP_CLIENT_ID
  GITHUB_APP_CLIENT_SECRET
  GITHUB_APP_PRIVATE_KEY
  GITHUB_APP_SLUG
  GITHUB_APP_WEBHOOK_SECRET
  BUILD_DISPATCH_TOKEN
)

for name in "${names[@]}"; do
  value="${!name:-}"
  if [ -z "${value:-}" ]; then
    echo "skip $name (not set in repo secrets)"
    continue
  fi
  printf '%s' "$value" | npx wrangler secret put "$name" --env production >/dev/null
  echo "updated $name"
done
