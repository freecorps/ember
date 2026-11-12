#!/usr/bin/env bash
# Start the open-source Convex backend locally (the binary `npx convex dev --local` downloads) and push ./convex to it.
#   docs/spikes/local-bench/up-convex.sh            (foreground; Ctrl-C stops it)
# State (url, admin key) goes to packages/cli/.tmp/convex-local/state.json, read by bench.ts. Nothing leaves the machine.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
D="$REPO/packages/cli/.tmp/convex-local"
BIN="${CONVEX_BACKEND:-$(ls -d "$HOME"/.cache/convex/binaries/*/convex-local-backend | sort | tail -1)}"
CONVEX_NM="$REPO/docs/spikes/remote/convex-bench/node_modules"   # convex@1.49.0
[ -d "$CONVEX_NM/convex" ] || (cd "$REPO/docs/spikes/remote/convex-bench" && bun install)
rm -rf "$D"; mkdir -p "$D/app"
SECRET="$(openssl rand -hex 32)"
KEY="$("$BIN" keygen admin-key --instance-name ember-bench-local --instance-secret "$SECRET")"
printf '{"url":"http://127.0.0.1:3210","adminKey":"%s","binary":"%s","knobs":"%s"}\n' "$KEY" "$(basename "$(dirname "$BIN")")" "${CONVEX_KNOBS:-default}" > "$D/state.json"
cp -R "$HERE/convex" "$D/app/convex"; rm -rf "$D/app/convex/_generated"
echo '{"name":"convex-local-bench","private":true,"type":"module","dependencies":{"convex":"1.49.0"}}' > "$D/app/package.json"
ln -s "$CONVEX_NM" "$D/app/node_modules"
# CONVEX_KNOBS=s256: the Professional plan's deployment class (256 concurrent queries/mutations) and every core for
# isolates; the local backend defaults to 16 concurrent queries.
if [ "${CONVEX_KNOBS:-}" = "s256" ]; then
  export APPLICATION_MAX_CONCURRENT_QUERIES=256 APPLICATION_MAX_CONCURRENT_MUTATIONS=256 APPLICATION_MAX_CONCURRENT_V8_ACTIONS=256 FUNRUN_ISOLATE_ACTIVE_THREADS="$(sysctl -n hw.ncpu 2>/dev/null || nproc)"
fi
"$BIN" --instance-name ember-bench-local --instance-secret "$SECRET" --port 3210 --site-proxy-port 3211 \
  --local-storage "$D/storage" --disable-beacon "$D/db.sqlite3" > "$D/backend.log" 2>&1 &
PID=$!
trap 'kill $PID 2>/dev/null' EXIT
for _ in $(seq 1 60); do curl -sf http://127.0.0.1:3210/version >/dev/null && break; sleep 0.5; done
(cd "$D/app" && env -u CONVEX_DEPLOYMENT CONVEX_SELF_HOSTED_URL=http://127.0.0.1:3210 CONVEX_SELF_HOSTED_ADMIN_KEY="$KEY" npx convex deploy -y)
echo "convex local backend up (pid $PID), log $D/backend.log"
wait $PID
