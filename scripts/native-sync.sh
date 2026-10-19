#!/bin/bash
# Sync sources to the fast native store (/root/.lemonaide) and run there.
# The npm workspace links in the store are relative (../../packages/*), so the
# package sources must live at /root/.lemonaide/packages/*. Node resolves
# node_modules from /root/.lemonaide/node_modules — f2fs, no proot overhead.
set -euo pipefail
SRC="/mnt/sdcard/projects/lemonaide-mcp"
DST="/root/.lemonaide"

for pkg in shared worker dashboard; do
  KEEP=""
  if [ -d "$DST/packages/$pkg/dist" ]; then
    KEEP="/tmp/lemonaide-keep-dist-$$"
    mv "$DST/packages/$pkg/dist" "$KEEP"
  fi
  rm -rf "$DST/packages/$pkg"
  mkdir -p "$DST/packages/$pkg"
  cp -a "$SRC/packages/$pkg/package.json" "$DST/packages/$pkg/"
  cp -a "$SRC/packages/$pkg/tsconfig.json" "$DST/packages/$pkg/" 2>/dev/null || true
  cp -a "$SRC/packages/$pkg/vite.config.ts" "$DST/packages/$pkg/" 2>/dev/null || true
  cp -a "$SRC/packages/$pkg/wrangler.toml" "$DST/packages/$pkg/" 2>/dev/null || true
  cp -a "$SRC/packages/$pkg/index.html" "$DST/packages/$pkg/" 2>/dev/null || true
  cp -a "$SRC/packages/$pkg/src" "$DST/packages/$pkg/"
  [ -d "$SRC/packages/$pkg/test" ] && cp -a "$SRC/packages/$pkg/test" "$DST/packages/$pkg/"
  if [ -n "$KEEP" ] && [ -d "$KEEP" ]; then mv "$KEEP" "$DST/packages/$pkg/dist"; fi
  true
done
cp -a "$SRC/package.json" "$DST/package.json"
cp -a "$SRC/eslint.config.js" "$DST/eslint.config.js"
cp -a "$SRC/tsconfig.base.json" "$DST/tsconfig.base.json" 2>/dev/null || true
echo "synced → $DST"
