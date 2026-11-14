#!/usr/bin/env bash
# Local before/after of one shard (Miniflare, EmberClient with batch frames): median of 5 runs per case.
#   docs/spikes/local-bench/ab-shard.sh <label>   → evidence/ab-<label>.txt
set -euo pipefail
cd "$(dirname "$0")/../../.."
OUT="docs/spikes/local-bench/evidence/ab-$1.txt"
: > "$OUT"
# CASES="noop 60000 100 6;put 60000 100 6" runs only those.
IFS=';' read -ra LIST <<< "${CASES:-noop 3000 1 1;put 3000 1 1;noop 60000 100 6;incr 60000 100 6;put 60000 100 6;put 1000 1 1 subs=100}"
for c in "${LIST[@]}"; do
  set -- $c
  subs=0; [ "${5:-}" = "subs=100" ] && subs=100
  xs=()
  for i in 1 2 3 4 5; do
    x=$(SUBS=$subs PROFILE=0 bun --conditions=@freecorps/ember-source run docs/spikes/remote/scripts/profile-shard.ts "$1" "$2" "$3" "$4" 2>&1 | grep -oE '[0-9.]+ µs/op' | grep -oE '^[0-9.]+')
    xs+=("$x")
  done
  med=$(printf '%s\n' "${xs[@]}" | sort -n | sed -n 3p)
  echo "$1 total=$2 window=$3 clients=$4 subs=$subs: median ${med} µs/op (runs ${xs[*]})" | tee -a "$OUT"
done
