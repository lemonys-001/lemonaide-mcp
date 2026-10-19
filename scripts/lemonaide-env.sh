#!/bin/bash
# Run a command with the LemonAIde node_modules bind applied.
#
# Background: this project lives on Android emulated storage (/mnt/sdcard) which
# does NOT support symlinks or exec bits, so npm cannot install into it directly.
# The dependency tree lives on the container's f2fs root at $STORE and is exposed
# at $ROOT/node_modules through a proot virtual bind (no kernel mount).
#
# Usage:
#   scripts/lemonaide-env.sh npm install
#   scripts/lemonaide-env.sh npm run typecheck
#   scripts/lemonaide-env.sh npm run dev -w @lemonaide/worker
set -euo pipefail

ROOT="/mnt/sdcard/projects/lemonaide-mcp"
STORE="/root/.lemonaide/node_modules"

mkdir -p "$STORE"
for extra in packages/worker/node_modules packages/shared/node_modules packages/dashboard/node_modules; do
  mkdir -p "$STORE/../$(echo "$extra" | tr / _)"
done

BINDS=(-b "$STORE:$ROOT/node_modules")
for extra in worker shared dashboard; do
  exdir="$STORE/../packages_${extra}_node_modules"
  mkdir -p "$exdir"
  BINDS+=(-b "$exdir:$ROOT/packages/$extra/node_modules")
done

cd "$ROOT"
exec proot "${BINDS[@]}" -0 -w "$ROOT" -w "$ROOT" env -i \
  HOME="$HOME" \
  PATH="/usr/local/bin:/usr/bin:/bin:/usr/local/sbin:/usr/sbin:/sbin" \
  TERM="${TERM:-xterm-256color}" \
  TMPDIR="${TMPDIR:-/tmp}" \
  npm_config_cache="${HOME}/.npm" \
  CLOUDFLARE_API_TOKEN="${CLOUDFLARE_API_TOKEN:-}" \
  CLOUDFLARE_ACCOUNT_ID="${CLOUDFLARE_ACCOUNT_ID:-}" \
  GITHUB_TOKEN="${GITHUB_TOKEN:-}" \
  "$@"
