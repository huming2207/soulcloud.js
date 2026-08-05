#!/usr/bin/env bash
# Runs all end-to-end suites against freshly started api + broker processes.
#
# Used by CI (.github/workflows/ci.yml) and locally. The processes are
# started with production entry points, waited for readiness, then the
# four suites run in order; any failure aborts with a non-zero exit code.
#
# Env: DATABASE_URL (required), JWT_SECRET (defaulted for CI), ports.
set -euo pipefail

cd "$(dirname "$0")/.."

export DATABASE_URL="${DATABASE_URL:-postgres://soulcloud:soulcloud@127.0.0.1:5432/soulcloud}"
# CI-only secret; a real deployment must set its own (fail-fast otherwise)
export JWT_SECRET="${JWT_SECRET:-ci-e2e-jwt-secret-0123456789-0123456789}"
export ROLLOUT_POLL_INTERVAL_MS="${ROLLOUT_POLL_INTERVAL_MS:-1000}"
export API_URL="${API_URL:-http://127.0.0.1:8080}"
export MQTT_WS_URL="${MQTT_WS_URL:-ws://127.0.0.1:1883/mqtt}"

API_LOG="$(mktemp)"
BROKER_LOG="$(mktemp)"
API_PID=""
BROKER_PID=""

cleanup() {
  if [ -n "$API_PID" ]; then kill "$API_PID" 2>/dev/null || true; fi
  if [ -n "$BROKER_PID" ]; then kill "$BROKER_PID" 2>/dev/null || true; fi
  wait 2>/dev/null || true
  rm -f "$API_LOG" "$BROKER_LOG"
}
trap cleanup EXIT

# --- start both processes ------------------------------------------------
echo "== starting api + broker =="
bun run packages/api/src/index.ts >"$API_LOG" 2>&1 &
API_PID=$!
bun run packages/broker/src/index.ts >"$BROKER_LOG" 2>&1 &
BROKER_PID=$!

# --- wait for readiness --------------------------------------------------
wait_http() {
  local url=$1 timeout=$2
  local deadline=$(( $(date +%s) + timeout ))
  while (( $(date +%s) < deadline )); do
    if curl -fsS "$url" >/dev/null 2>&1; then return 0; fi
    if ! kill -0 "$API_PID" 2>/dev/null; then
      echo "api process exited early:" >&2
      tail -20 "$API_LOG" >&2
      return 1
    fi
    sleep 0.5
  done
  echo "timeout waiting for $url" >&2
  tail -20 "$API_LOG" >&2
  return 1
}

wait_port() {
  local host=$1 port=$2 timeout=$3
  local deadline=$(( $(date +%s) + timeout ))
  while (( $(date +%s) < deadline )); do
    if (exec 3<>"/dev/tcp/$host/$port") 2>/dev/null; then
      exec 3>&- 3<&-
      return 0
    fi
    if ! kill -0 "$BROKER_PID" 2>/dev/null; then
      echo "broker process exited early:" >&2
      tail -20 "$BROKER_LOG" >&2
      return 1
    fi
    sleep 0.5
  done
  echo "timeout waiting for broker port $port" >&2
  tail -20 "$BROKER_LOG" >&2
  return 1
}

wait_http "$API_URL/health/ready" 30
wait_port 127.0.0.1 1883 30
echo "== processes ready =="

# --- run the suites ------------------------------------------------------
FAILED=0
for suite in e2e.ts e2e-logging.ts e2e-ota.ts e2e-rollout.ts; do
  echo "== $suite =="
  if ! bun "scripts/$suite"; then
    echo "FAILED: $suite" >&2
    FAILED=1
    break
  fi
done

if [ "$FAILED" -eq 0 ]; then
  echo "== ALL E2E SUITES PASSED =="
fi
exit "$FAILED"
