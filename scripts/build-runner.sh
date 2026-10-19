#!/usr/bin/env bash
# LemonAIde isolated build runner — executes inside GitHub Actions.
# Trusts ONLY the commands returned by the platform (FRAMEWORK_BUILD_CONFIG);
# never executes commands from user source.
set -euo pipefail

BUILD_ID="${1:?build id required}"
: "${WORKER_BASE_URL:?WORKER_BASE_URL required}"
: "${BUILD_RUNNER_TOKEN:?BUILD_RUNNER_TOKEN required}"

BASE="${WORKER_BASE_URL%/}"
API="$BASE/api/internal/builds/$BUILD_ID"
WORKDIR="$RUNNER_TEMP/lemonaide-build"
LOG="$RUNNER_TEMP/build.log"
mkdir -p "$WORKDIR"
: > "$LOG"

log() { printf '%s\n' "$*" | tee -a "$LOG" >&2; }
post_log() {
  python3 - "$LOG" <<'PY' || true
import json, sys, os, urllib.request
path = sys.argv[1]
content = open(path, "r", errors="replace").read()
body = json.dumps({"content": content}).encode()
req = urllib.request.Request(
    os.environ["API"] + "/logs",
    data=body,
    headers={"content-type": "application/json", "authorization": "Bearer " + os.environ["BUILD_RUNNER_TOKEN"]},
    method="POST",
)
try:
    urllib.request.urlopen(req, timeout=30)
except Exception as exc:  # noqa: BLE001 — logging must never fail the build
    print(f"log post failed: {exc}", file=sys.stderr)
PY
}
fail() {
  status="${2:-failed}"
  log "ERROR: $1"
  post_log
  python3 - "$status" "$1" <<'PY'
import json, sys, os, urllib.request
body = json.dumps({"status": sys.argv[1], "error_code": "BUILD_FAILED", "error_message": sys.argv[2][:1000]}).encode()
req = urllib.request.Request(
    os.environ["API"] + "/complete",
    data=body,
    headers={"content-type": "application/json", "authorization": "Bearer " + os.environ["BUILD_RUNNER_TOKEN"]},
    method="POST",
)
urllib.request.urlopen(req, timeout=30)
PY
  exit 1
}

export API

log "▶ build $BUILD_ID starting (run ${GITHUB_RUN_ID:-local})"
python3 - <<PY
import json, os, urllib.request
req = urllib.request.Request(
    os.environ["API"] + "/start",
    data=json.dumps({"runner_run_id": int(os.environ.get("GITHUB_RUN_ID") or 0)}).encode(),
    headers={"content-type": "application/json", "authorization": "Bearer " + os.environ["BUILD_RUNNER_TOKEN"]},
    method="POST",
)
urllib.request.urlopen(req, timeout=30)
PY

# ── fetch source snapshot ────────────────────────────────────────────
curl -sfS -H "authorization: Bearer $BUILD_RUNNER_TOKEN" "$API/source" -o "$RUNNER_TEMP/bundle.json" \
  || fail "failed to download source bundle"

python3 - "$RUNNER_TEMP/bundle.json" "$WORKDIR" <<'PY'
import json, os, sys
bundle = json.load(open(sys.argv[1]))
root = sys.argv[2]
for f in bundle["files"]:
    dest = os.path.join(root, f["path"])
    os.makedirs(os.path.dirname(dest) or root, exist_ok=True)
    with open(dest, "w", encoding="utf-8") as fh:
        fh.write(f["content"])
print(f"extracted {len(bundle['files'])} files")
PY

cd "$WORKDIR"

INSTALL_CMD=$(python3 -c "import json,sys;print(json.load(open(sys.argv[1])).get('installCommand') or '')" "$RUNNER_TEMP/bundle.json")
BUILD_CMD=$(python3 -c "import json,sys;print(json.load(open(sys.argv[1])).get('buildCommand') or '')" "$RUNNER_TEMP/bundle.json")
OUT_DIR=$(python3 -c "import json,sys;print(json.load(open(sys.argv[1])).get('outputDir') or 'dist')" "$RUNNER_TEMP/bundle.json")

# ── install ──────────────────────────────────────────────────────────
if [[ -n "$INSTALL_CMD" ]]; then
  log "▶ install: $INSTALL_CMD"
  bash -c "$INSTALL_CMD" >> "$LOG" 2>&1 || { post_log; fail "dependency installation failed"; }
  post_log
else
  log "▶ install skipped"
fi

# ── build ────────────────────────────────────────────────────────────
if [[ -n "$BUILD_CMD" ]]; then
  log "▶ build: $BUILD_CMD"
  bash -c "$BUILD_CMD" >> "$LOG" 2>&1 || { post_log; fail "build command failed"; }
else
  log "▶ build skipped (static source copy)"
fi
post_log

# ── validate + upload output ─────────────────────────────────────────
if [[ "$OUT_DIR" == "." ]]; then SRC="$WORKDIR"; else SRC="$WORKDIR/$OUT_DIR"; fi
[[ -d "$SRC" ]] || fail "output directory '$OUT_DIR' does not exist"
[[ -f "$SRC/index.html" ]] || fail "build produced no index.html"

python3 - "$SRC" <<'PY'
import base64, json, mimetypes, os, sys, urllib.request

src = sys.argv[1]
API = os.environ["API"]
TOKEN = os.environ["BUILD_RUNNER_TOKEN"]

files = []
for root, _dirs, names in os.walk(src):
    for name in names:
        full = os.path.join(root, name)
        rel = os.path.relpath(full, src).replace(os.sep, "/")
        with open(full, "rb") as fh:
            data = fh.read()
        files.append((rel, base64.b64encode(data).decode()))
print(f"uploading {len(files)} artifacts", file=sys.stderr)

BATCH = 40
for i in range(0, len(files), BATCH):
    chunk = [{"path": p, "content": c, "encoding": "base64"} for p, c in files[i : i + BATCH]]
    body = json.dumps({"files": chunk}).encode()
    req = urllib.request.Request(
        API + "/artifacts",
        data=body,
        headers={"content-type": "application/json", "authorization": "Bearer " + TOKEN},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=120) as res:
        print(f"batch {i // BATCH + 1}: {res.status}", file=sys.stderr)
print("upload done", file=sys.stderr)
PY

python3 - <<'PY'
import json, os, urllib.request
body = json.dumps({"status": "succeeded"}).encode()
req = urllib.request.Request(
    os.environ["API"] + "/complete",
    data=body,
    headers={"content-type": "application/json", "authorization": "Bearer " + os.environ["BUILD_RUNNER_TOKEN"]},
    method="POST",
)
urllib.request.urlopen(req, timeout=30)
PY

log "✔ build $BUILD_ID succeeded"
