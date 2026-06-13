#!/usr/bin/env bash

set -euo pipefail

RUN_DURATION=$((60*5))
SERVER_TIMEOUT=60
AGENT_TIMEOUT=60
BETWEEN_MAP_SLEEP=2
AGENT_TOKEN_BDI=$(grep '^AGENT_TOKEN_BDI=' .env | cut -d '=' -f2-)
MAPS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    -d|--duration)
      RUN_DURATION="$2"
      shift 2
      ;;
    --server-timeout)
      SERVER_TIMEOUT="$2"
      shift 2
      ;;
    --agent-timeout)
      AGENT_TIMEOUT="$2"
      shift 2
      ;;
    *)
      MAPS+=("$1")
      shift
      ;;
  esac
done

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(realpath "$ROOT/..")"

BACKEND="$(realpath "$PROJECT_ROOT/Deliveroo.js/backend")"
AGENT="$ROOT"
GAMES_DIR="$(realpath "$PROJECT_ROOT/Deliveroo.js/packages/@unitn-asa/deliveroo-js-assets/assets/games")"

RESULTS_DIR="$ROOT/results"
mkdir -p "$RESULTS_DIR"
RESULTS="$RESULTS_DIR/benchmark_results.csv"

SERVER_URL="http://localhost:8080"
AGENTS_API="$SERVER_URL/api/agents"

SERVER_STDOUT="$ROOT/server_stdout.log"
SERVER_STDERR="$ROOT/server_stderr.log"
AGENT_STDOUT="$ROOT/agent_stdout.log"
AGENT_STDERR="$ROOT/agent_stderr.log"

wait_port_free() {
  local timeout="${1:-10}"
  local start
  start="$(date +%s)"

  while true; do
    if ! lsof -ti :8080 >/dev/null 2>&1; then
      return 0
    fi

    local now
    now="$(date +%s)"

    if (( now - start >= timeout )); then
      return 1
    fi

    sleep 0.2
  done
}

kill_port_8080() {
  if ! command -v lsof >/dev/null 2>&1; then
    echo "  Warning: lsof not installed. Install it with: sudo apt install -y lsof"
    return 0
  fi

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

initial_cleanup() {
  echo "Initial cleanup..."

  kill_matching_processes
  kill_port_8080
  wait_port_free 10 || true

  sleep 1
}

kill_process_group() {
  local pid="${1:-}"
  local label="${2:-process}"

  if [[ -z "$pid" ]]; then
    return 0
  fi

  if kill -0 "$pid" 2>/dev/null; then
    echo "  Stopping $label process group: $pid"
    kill -TERM "-$pid" 2>/dev/null || true
    sleep 0.7
    kill -KILL "-$pid" 2>/dev/null || true
  fi
}

cleanup_run() {
  local agent_pid="${1:-}"
  local server_pid="${2:-}"

  kill_process_group "$agent_pid" "agent"
  kill_process_group "$server_pid" "server"

  kill_matching_processes
  kill_port_8080
  wait_port_free 10 || true

  sleep "$BETWEEN_MAP_SLEEP"
}

wait_server() {
  local timeout="${1:-60}"
  local start
  start="$(date +%s)"

  while true; do
    if curl -fsS "$AGENTS_API" >/dev/null 2>&1; then
      return 0
    fi

    local now
    now="$(date +%s)"

    if (( now - start >= timeout )); then
      return 1
    fi

    sleep 0.5
  done
}

wait_agent_registered() {
  local timeout="${1:-60}"
  local start
  start="$(date +%s)"

  while true; do
    if curl -fsS "$AGENTS_API" 2>/dev/null | node -e '
      let data = "";

      process.stdin.on("data", chunk => data += chunk);

      process.stdin.on("end", () => {
        try {
          const agents = JSON.parse(data);
          process.exit(Array.isArray(agents) && agents.length > 0 ? 0 : 1);
        } catch {
          process.exit(1);
        }
      });
    '; then
      return 0
    fi

    local now
    now="$(date +%s)"

    if (( now - start >= timeout )); then
      return 1
    fi

    sleep 0.3
  done
}

get_agent_score() {
  curl -fsS "$AGENTS_API" 2>/dev/null | node -e '
    let data = "";

    process.stdin.on("data", chunk => data += chunk);

    process.stdin.on("end", () => {
      try {
        const agents = JSON.parse(data);

        if (!Array.isArray(agents) || agents.length === 0) {
          console.log("N/A,N/A,N/A");
          return;
        }

        agents.sort((a, b) => (b.score ?? -Infinity) - (a.score ?? -Infinity));

        const best = agents[0];

        const score = best.score ?? "N/A";
        const penalty = best.penalty ?? "N/A";
        const net =
          typeof score === "number" && typeof penalty === "number"
            ? score + penalty
            : "N/A";

        console.log(`${score},${penalty},${net}`);
      } catch {
        console.log("N/A,N/A,N/A");
      }
    });
  ' || echo "N/A,N/A,N/A"
}

print_last_logs() {
  local label="${1:-logs}"

  echo "  Last $label server stdout:"
  tail -n 60 "$SERVER_STDOUT" 2>/dev/null || true

  echo "  Last $label server stderr:"
  tail -n 60 "$SERVER_STDERR" 2>/dev/null || true

  echo "  Last $label agent stdout:"
  tail -n 60 "$AGENT_STDOUT" 2>/dev/null || true

  echo "  Last $label agent stderr:"
  tail -n 60 "$AGENT_STDERR" 2>/dev/null || true
}

on_exit() {
  echo ""
  echo "Cleaning up before exit..."
  initial_cleanup
}

trap on_exit EXIT INT TERM

if [[ ! -d "$BACKEND" ]]; then
  echo "Backend directory not found: $BACKEND" >&2
  exit 1
fi

if [[ ! -d "$AGENT" ]]; then
  echo "Agent directory not found: $AGENT" >&2
  exit 1
fi

if [[ ! -d "$GAMES_DIR" ]]; then
  echo "Games directory not found: $GAMES_DIR" >&2
  exit 1
fi

if ! command -v lsof >/dev/null 2>&1; then
  echo "lsof is required. Install it with:"
  echo "sudo apt install -y lsof"
  exit 1
fi

if ! command -v curl >/dev/null 2>&1; then
  echo "curl is required. Install it with:"
  echo "sudo apt install -y curl"
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "node is required."
  exit 1
fi

if [[ ${#MAPS[@]} -eq 0 ]]; then
  mapfile -t ALL_MAPS < <(
    find "$GAMES_DIR" -maxdepth 1 -name "26c1_*.json" -printf "%f\n" |
    sed 's/\.json$//' |
    sort
  )
else
  ALL_MAPS=("${MAPS[@]}")
fi

if [[ ${#ALL_MAPS[@]} -eq 0 ]]; then
  echo "No maps found in $GAMES_DIR" >&2
  exit 1
fi

echo "Maps to benchmark (${#ALL_MAPS[@]}): $(IFS=,; echo "${ALL_MAPS[*]}")"
echo "Duration per map: $RUN_DURATION seconds"
echo "Server timeout: $SERVER_TIMEOUT seconds"
echo "Agent timeout: $AGENT_TIMEOUT seconds"
echo "Results file: $RESULTS"
echo ""

echo "map,score,penalty,net_score,duration_s,timestamp,status" > "$RESULTS"

initial_cleanup

for map in "${ALL_MAPS[@]}"; do
  map_file="$GAMES_DIR/$map.json"

  echo "-------------------------------------------"
  echo "Map: $map"
  echo "  Map file: $map_file"

  score="N/A"
  penalty="N/A"
  net="N/A"
  elapsed=0
  status="OK"
  server_pid=""
  agent_pid=""

  if [[ ! -f "$map_file" ]]; then
    echo "  Map file not found: $map_file"
    ts="$(date '+%Y-%m-%d %H:%M:%S')"
    echo "$map,$score,$penalty,$net,$elapsed,$ts,MAP_NOT_FOUND" >> "$RESULTS"
    continue
  fi

  if lsof -ti :8080 >/dev/null 2>&1; then
    echo "  Port 8080 busy before starting map. Cleaning..."
    kill_port_8080
    wait_port_free 10 || true
  fi

  : > "$SERVER_STDOUT"
  : > "$SERVER_STDERR"
  : > "$AGENT_STDOUT"
  : > "$AGENT_STDERR"

  echo "  Starting server..."

  setsid bash -lc "
    cd \"$BACKEND\"
    exec npm start -- \"-g=$map_file\"
  " > "$SERVER_STDOUT" 2> "$SERVER_STDERR" &

  server_pid=$!

  echo "  Server PID $server_pid starting..."

  if ! wait_server "$SERVER_TIMEOUT"; then
    echo "  Server did not become ready in ${SERVER_TIMEOUT}s - skipping $map"
    print_last_logs "failed-start"
    status="SERVER_TIMEOUT"
    ts="$(date '+%Y-%m-%d %H:%M:%S')"
    echo "$map,$score,$penalty,$net,$elapsed,$ts,$status" >> "$RESULTS"
    cleanup_run "" "$server_pid"
    continue
  fi

  echo "  Server ready."

  sleep 1

  echo "  Starting agent..."

  setsid bash -lc "
    cd \"$AGENT\"
    exec node --experimental-strip-types main.ts --token=\"${AGENT_TOKEN_BDI}\"
  " > "$AGENT_STDOUT" 2> "$AGENT_STDERR" &

  agent_pid=$!

  echo "  Agent PID $agent_pid started. Waiting for registration..."

  if ! wait_agent_registered "$AGENT_TIMEOUT"; then
    echo "  Agent did not register in ${AGENT_TIMEOUT}s - skipping $map"
    print_last_logs "agent-registration"
    status="AGENT_TIMEOUT"
    ts="$(date '+%Y-%m-%d %H:%M:%S')"
    echo "$map,$score,$penalty,$net,$elapsed,$ts,$status" >> "$RESULTS"
    cleanup_run "$agent_pid" "$server_pid"
    continue
  fi

  echo "  Agent registered. Starting benchmark timer for $RUN_DURATION s..."

  start_time="$(date +%s)"
  sleep "$RUN_DURATION"
  end_time="$(date +%s)"
  elapsed=$((end_time - start_time))

  IFS=',' read -r score penalty net <<< "$(get_agent_score)"

  ts="$(date '+%Y-%m-%d %H:%M:%S')"

  echo "  Score: $score  |  Penalty: $penalty  |  Net: $net  |  Elapsed: $elapsed s"

  cleanup_run "$agent_pid" "$server_pid"

  echo "$map,$score,$penalty,$net,$elapsed,$ts,$status" >> "$RESULTS"
done

echo ""
echo "-------------------------------------------"
echo "Benchmark complete. Results in: $RESULTS"
echo ""

if command -v column >/dev/null 2>&1; then
  column -s, -t "$RESULTS"
else
  cat "$RESULTS"
fi