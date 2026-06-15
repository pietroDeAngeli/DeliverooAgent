#!/usr/bin/env bash
# Starts a master agent (LLM-enabled) and a slave agent, sharing their IDs.
#
# Usage:
#   ./start_multi_agent.sh
#
# Reads AGENT_TOKEN_LLM (master) and AGENT_TOKEN_BDI (slave) from .env.
# Decodes the player ID from each JWT and passes the slave's ID to the master
# as PARTNER_ID so it can forward LLM updates immediately via emitSay.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$SCRIPT_DIR/.env"

# Load .env
if [[ -f "$ENV_FILE" ]]; then
    set -o allexport
    # shellcheck disable=SC1090
    source "$ENV_FILE"
    set +o allexport
else
    echo "ERROR: .env not found at $ENV_FILE" >&2
    exit 1
fi

MASTER_TOKEN="${AGENT_TOKEN_LLM:-}"
SLAVE_TOKEN="${AGENT_TOKEN_BDI:-}"

if [[ -z "$MASTER_TOKEN" ]]; then
    echo "ERROR: AGENT_TOKEN_LLM is not set in .env" >&2
    exit 1
fi
if [[ -z "$SLAVE_TOKEN" ]]; then
    echo "ERROR: AGENT_TOKEN_BDI is not set in .env" >&2
    exit 1
fi

# Decode the player ID from a JWT payload (second segment, base64url-encoded JSON)
decode_jwt_id() {
    local token="$1"
    local payload
    payload=$(echo "$token" | cut -d'.' -f2)
    # base64url → base64 (pad to multiple of 4)
    local padded="$payload"
    case $(( ${#padded} % 4 )) in
        2) padded="${padded}==" ;;
        3) padded="${padded}=" ;;
    esac
    # Replace URL-safe chars and decode
    echo "$padded" | tr '_-' '/+' | base64 -d 2>/dev/null \
        | node --input-type=module -e \
            "import { createInterface } from 'readline';
             const rl = createInterface({ input: process.stdin });
             let data = '';
             rl.on('line', l => data += l);
             rl.on('close', () => console.log(JSON.parse(data).id));"
}

echo "Decoding agent IDs from tokens..."
MASTER_ID=$(decode_jwt_id "$MASTER_TOKEN")
SLAVE_ID=$(decode_jwt_id "$SLAVE_TOKEN")

echo "  Master: $MASTER_ID  (AGENT_TOKEN_LLM)"
echo "  Slave:  $SLAVE_ID   (AGENT_TOKEN_BDI)"
echo ""

# Cleanup on exit
cleanup() {
    echo ""
    echo "Stopping agents..."
    kill "$MASTER_PID" "$SLAVE_PID" 2>/dev/null || true
    wait "$MASTER_PID" "$SLAVE_PID" 2>/dev/null || true
    echo "Done."
}
trap cleanup EXIT INT TERM

# Start master: LLM-enabled, knows slave's ID upfront
echo "[master] Starting..."
env TOKEN="$MASTER_TOKEN" IS_MASTER=true USE_LLM=true PARTNER_ID="$SLAVE_ID" \
    node --experimental-strip-types "$SCRIPT_DIR/main.ts" \
    2>&1 | sed 's/^/[master] /' &
MASTER_PID=$!

# Small delay so the master connects first (cleaner logs)
sleep 1

# Start slave: no LLM, will receive updates from master
echo "[slave]  Starting..."
env TOKEN="$SLAVE_TOKEN" IS_MASTER=false PARTNER_ID="$MASTER_ID" \
    node --experimental-strip-types "$SCRIPT_DIR/main.ts" \
    2>&1 | sed 's/^/[slave]  /' &
SLAVE_PID=$!

echo ""
echo "Both agents running. Press Ctrl+C to stop."
wait
