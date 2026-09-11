#!/usr/bin/env bash
# A/B on Linux (WSL): fixed compiled binary with daemon vs. SEMANTIUS_NO_DAEMON=1,
# same scenarios as the Windows harness, against the real crud server. Bash-only timing.
export PATH="$HOME/.bun/bin:$PATH"
REPO=/mnt/c/dev/semantius-cli
ITER=${1:-8}
OUT=${2:-/tmp/semantius-wsl-bench}
mkdir -p "$OUT"
cd "$REPO" || exit 1
BIN="$OUT/semantius"
bun build --compile --minify src/index.ts --outfile "$BIN" >/dev/null 2>&1 || { echo BUILD FAILED; exit 1; }
"$BIN" --version
export SEMANTIUS_LOG_LEVELS=all SEMANTIUS_LOG_FILE="$OUT/cli.jsonl" SEMANTIUS_DAEMON_TIMEOUT=600
: > "$OUT/samples.tsv"
echo "# mode scenario iter wall_ms mcp_ms daemon_events_so_far" >> "$OUT/samples.tsv"

declare -A ARGS
ARGS[user]='getCurrentUser {}'
ARGS[single]="postgrestRequest --single {\"method\":\"GET\",\"path\":\"/products?id=eq.1\"}"
ARGS[page100]='postgrestRequest {"method":"GET","path":"/orders?order=id.asc&limit=100"}'
ARGS[page1000]='postgrestRequest {"method":"GET","path":"/order_details?order=id.asc&limit=1000"}'
ARGS[full]='postgrestRequest {"method":"GET","path":"/order_details?order=id.asc&limit=10000"}'
SCEN="user single page100 page1000 full"

run_one() { # mode scenario iter
  local mode=$1 s=$2 i=$3 t0 t1 wall mcp ev
  local -a a
  read -r -a a <<< "${ARGS[$s]}"
  # last element is the JSON; rejoin in case it was split on spaces (none of ours contain spaces)
  t0=$EPOCHREALTIME
  if [ "$mode" = nodaemon ]; then
    SEMANTIUS_NO_DAEMON=1 "$BIN" call crud "${a[@]}" >/dev/null 2>"$OUT/err.txt"
  else
    "$BIN" call crud "${a[@]}" >/dev/null 2>"$OUT/err.txt"
  fi
  local rc=$?
  t1=$EPOCHREALTIME
  wall=$(awk -v a="$t0" -v b="$t1" 'BEGIN{printf "%d", (b-a)*1000}')
  mcp=$(grep '"log_type":"request"' "$OUT/cli.jsonl" | tail -1 | sed -n 's/.*"mcp_ms":\([0-9]*\).*/\1/p')
  ev=$(grep -c '"event":"daemon_start"' "$OUT/cli.jsonl")
  [ $rc -ne 0 ] && echo "FAIL rc=$rc: $(grep -v Bearer "$OUT/err.txt" | head -c 700)"
  printf "%s\t%s\t%s\t%s\t%s\t%s\n" "$mode" "$s" "$i" "$wall" "${mcp:--}" "$ev" >> "$OUT/samples.tsv"
  printf "%-9s %-9s #%s %6s ms (mcp %s)\n" "$mode" "$s" "$i" "$wall" "${mcp:--}"
}

echo "### warm-up (fills the JWT cache and starts the daemon)"
"$BIN" call crud getCurrentUser '{}' >/dev/null 2>&1; "$BIN" call crud getCurrentUser '{}' >/dev/null 2>&1
echo "### daemon events after warm-up: $(grep -c '"event":"daemon_start"' "$OUT/cli.jsonl")"
for ((i=0;i<ITER;i++)); do
  for s in $SCEN; do
    run_one daemon "$s" "$i"
    run_one nodaemon "$s" "$i"
  done
done
echo "### summary (median wall ms)"
for mode in daemon nodaemon; do for s in $SCEN; do
  awk -F'\t' -v m="$mode" -v s="$s" '$1==m && $2==s {print $4}' "$OUT/samples.tsv" | sort -n | awk -v m="$mode" -v s="$s" '{a[NR]=$1} END{printf "%-9s %-9s n=%d min=%d median=%d max=%d\n", m, s, NR, a[1], a[int((NR+1)/2)], a[NR]}'
done; done
echo "### daemon_start events total: $(grep -c '"event":"daemon_start"' "$OUT/cli.jsonl")"
