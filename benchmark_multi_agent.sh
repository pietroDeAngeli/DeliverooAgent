#!/usr/bin/env bash
# Interactive map selector + timed benchmark runner.
# Delegates agent startup to start_multi_agent.sh so all agent output is visible.

set -euo pipefail

RUN_DURATION=$((60*5))
SERVER_TIMEOUT=60
AGENT_TIMEOUT=60
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$ROOT/.env"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "ERROR: .env not found at $ENV_FILE" >&2
  exit 1
fi

set -o allexport
# shellcheck disable=SC1090
source "$ENV_FILE"
set +o allexport

while [[ $# -gt 0 ]]; do
  case "$1" in
    -d|--duration)      RUN_DURATION="$2";   shift 2 ;;
    --server-timeout)   SERVER_TIMEOUT="$2"; shift 2 ;;
    --agent-timeout)    AGENT_TIMEOUT="$2";  shift 2 ;;
    *) shift ;;
  esac
done

PROJECT_ROOT="$(realpath "$ROOT/..")"
BACKEND="$(realpath "$PROJECT_ROOT/Deliveroo.js/backend")"
GAMES_DIR="$(realpath "$PROJECT_ROOT/Deliveroo.js/packages/@unitn-asa/deliveroo-js-assets/assets/games")"
RESULTS_DIR="$ROOT/results"
mkdir -p "$RESULTS_DIR"
RESULTS="$RESULTS_DIR/multi_agent_benchmark.csv"
SERVER_URL="http://localhost:8080"
AGENTS_API="$SERVER_URL/api/agents"
SERVER_LOG="$ROOT/server_stdout.log"

# ── helpers ────────────────────────────────────────────────────────────────────

wait_port_free() {
  local timeout="${1:-10}" start now
  start="$(date +%s)"
  while true; do
    ! lsof -ti :8080 >/dev/null 2>&1 && return 0
    now="$(date +%s)"
    (( now - start >= timeout )) && return 1
    sleep 0.2
  done
}

kill_port_8080() {
  local pids
  pids="$(lsof -ti :8080 2>/dev/null || true)"
  if [[ -n "$pids" ]]; then
    echo "  Killing process(es) on port 8080: $pids"
    kill -TERM $pids 2>/dev/null || true
    sleep 0.7
    kill -KILL $pids 2>/dev/null || true
  fi
}

kill_matching_processes() {
  pkill -f "node --experimental-strip-types main.ts" 2>/dev/null || true
  pkill -f "node main.ts" 2>/dev/null || true
  pkill -f "nodemon" 2>/dev/null || true
  pkill -f "backend/index.js" 2>/dev/null || true
  pkill -f "Deliveroo.js/backend" 2>/dev/null || true
  pkill -f "npm start" 2>/dev/null || true
  pkill -f "npm run dev" 2>/dev/null || true
}

wait_server() {
  local timeout="${1:-60}" start now
  start="$(date +%s)"
  while true; do
    curl -fsS "$AGENTS_API" >/dev/null 2>&1 && return 0
    now="$(date +%s)"
    (( now - start >= timeout )) && return 1
    sleep 0.5
  done
}

wait_agent_registered() {
  local timeout="${1:-60}" start now
  start="$(date +%s)"
  while true; do
    if curl -fsS "$AGENTS_API" 2>/dev/null | node -e '
      let d = "";
      process.stdin.on("data", c => d += c);
      process.stdin.on("end", () => {
        try { const a = JSON.parse(d); process.exit(Array.isArray(a) && a.length >= 2 ? 0 : 1); }
        catch { process.exit(1); }
      });
    '; then
      return 0
    fi
    now="$(date +%s)"
    (( now - start >= timeout )) && return 1
    sleep 0.3
  done
}

get_agent_scores() {
  curl -fsS "$AGENTS_API" 2>/dev/null | node -e '
    let d = "";
    process.stdin.on("data", c => d += c);
    process.stdin.on("end", () => {
      try {
        const agents = JSON.parse(d);
        if (!Array.isArray(agents) || agents.length === 0) { console.log("N/A,N/A,N/A,N/A,N/A,N/A"); return; }
        agents.sort((a, b) => (b.score ?? -Infinity) - (a.score ?? -Infinity));
        const result = [];
        for (let i = 0; i < 2; i++) {
          const a = agents[i] ?? {};
          const score = a.score ?? "N/A";
          const penalty = a.penalty ?? "N/A";
          const net = typeof score === "number" && typeof penalty === "number" ? score + penalty : "N/A";
          result.push(`${a.name ?? a.id ?? "agent" + (i+1)},${score},${penalty},${net}`);
        }
        console.log(result.join(","));
      } catch { console.log("N/A,N/A,N/A,N/A,N/A,N/A,N/A,N/A"); }
    });
  ' || echo "N/A,N/A,N/A,N/A,N/A,N/A,N/A,N/A"
}

# ── cleanup ────────────────────────────────────────────────────────────────────

server_pid=""
agents_pid=""

cleanup() {
  echo ""
  echo "Cleaning up..."
  [[ -n "$agents_pid" ]] && kill -TERM "-$agents_pid" 2>/dev/null || true
  sleep 0.5
  [[ -n "$server_pid" ]] && kill -TERM "-$server_pid" 2>/dev/null || true
  kill_matching_processes
  kill_port_8080
  wait_port_free 10 || true
}
trap cleanup EXIT INT TERM

# ── prereq checks ──────────────────────────────────────────────────────────────

for cmd in lsof curl node; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Required command not found: $cmd" >&2
    exit 1
  fi
done

if [[ ! -d "$BACKEND" ]]; then  echo "Backend not found: $BACKEND" >&2; exit 1; fi
if [[ ! -d "$GAMES_DIR" ]]; then echo "Games dir not found: $GAMES_DIR" >&2; exit 1; fi

# ── map selection ──────────────────────────────────────────────────────────────

mapfile -t ALL_MAPS < <(
  find "$GAMES_DIR" -maxdepth 1 -name "26c1_*.json" -printf "%f\n" |
  sed 's/\.json$//' | sort
)

if [[ ${#ALL_MAPS[@]} -eq 0 ]]; then
  echo "No maps found in $GAMES_DIR" >&2
  exit 1
fi

echo "Available maps:"
for i in "${!ALL_MAPS[@]}"; do
  printf "  %2d. %s\n" "$((i+1))" "${ALL_MAPS[$i]}"
done
echo ""

while true; do
  read -rp "Select map (1-${#ALL_MAPS[@]}): " sel
  if [[ "$sel" =~ ^[0-9]+$ ]] && (( sel >= 1 && sel <= ${#ALL_MAPS[@]} )); then
    map="${ALL_MAPS[$((sel-1))]}"
    break
  fi
  echo "  Invalid selection, enter a number between 1 and ${#ALL_MAPS[@]}."
done

map_file="$GAMES_DIR/$map.json"
echo ""
echo "Map:      $map"
echo "Duration: $RUN_DURATION s"
echo "Results:  $RESULTS"
echo ""

# ── initial cleanup ────────────────────────────────────────────────────────────

echo "Cleaning up any leftover processes..."
kill_matching_processes
kill_port_8080
wait_port_free 10 || true
sleep 1

# ── start server ───────────────────────────────────────────────────────────────

echo "Starting server (logs: $SERVER_LOG)..."
: > "$SERVER_LOG"
setsid bash -lc "
  cd \"$BACKEND\"
  exec npm start -- \"-g=$map_file\"
" > "$SERVER_LOG" 2>&1 &
server_pid=$!
echo "Server PID: $server_pid"

if ! wait_server "$SERVER_TIMEOUT"; then
  echo "Server did not become ready in ${SERVER_TIMEOUT}s" >&2
  echo "Last server output:"
  tail -n 30 "$SERVER_LOG"
  exit 1
fi
echo "Server ready."
echo ""

# ── start agents ───────────────────────────────────────────────────────────────

echo "Starting agents via start_multi_agent.sh..."
setsid bash "$ROOT/start_multi_agent.sh" &
agents_pid=$!
echo "Agents process group: $agents_pid"
echo ""

if ! wait_agent_registered "$AGENT_TIMEOUT"; then
  echo "Agents did not register in ${AGENT_TIMEOUT}s" >&2
  exit 1
fi

echo ""
echo "=== Both agents registered. Benchmark running for $RUN_DURATION s... ==="
echo ""

# ── run timer ──────────────────────────────────────────────────────────────────

start_time="$(date +%s)"
sleep "$RUN_DURATION"
end_time="$(date +%s)"
elapsed=$((end_time - start_time))

# ── collect scores ─────────────────────────────────────────────────────────────

echo ""
echo "=== Time's up! Collecting scores... ==="
IFS=',' read -r a1_name a1_score a1_penalty a1_net a2_name a2_score a2_penalty a2_net <<< "$(get_agent_scores)"
ts="$(date '+%Y-%m-%d %H:%M:%S')"

echo "  Agent1 ($a1_name): score=$a1_score  penalty=$a1_penalty  net=$a1_net"
echo "  Agent2 ($a2_name): score=$a2_score  penalty=$a2_penalty  net=$a2_net"
echo "  Elapsed: ${elapsed}s"
echo ""

# Write CSV (create with header if new)
if [[ ! -f "$RESULTS" ]]; then
  echo "map,agent1_name,agent1_score,agent1_penalty,agent1_net,agent2_name,agent2_score,agent2_penalty,agent2_net,duration_s,timestamp" > "$RESULTS"
fi
echo "$map,$a1_name,$a1_score,$a1_penalty,$a1_net,$a2_name,$a2_score,$a2_penalty,$a2_net,$elapsed,$ts" >> "$RESULTS"

echo "Result appended to: $RESULTS"
echo ""
if command -v column >/dev/null 2>&1; then
  column -s, -t "$RESULTS"
else
  cat "$RESULTS"
fi
