#!/usr/bin/env bash
# Web <-> API E2E for CI (and locally).
#
# Strategy: the browser validates that the real frontend renders real
# backend data (login-state pages, device rows, firmware/rollouts empty
# states), while business operations (login, device creation) go through
# the API layer where they are deterministic. All browser calls share one
# explicit agent-browser session so the browser stays alive across calls.
#
# Prerequisites: agent-browser on PATH (npm i -g agent-browser &&
# agent-browser install), DATABASE_URL reachable, JWT_SECRET set.
set -euo pipefail
cd "$(dirname "$0")/.."

SESSION="web-e2e"
# dedicated API port: local machines often have the firmware E2E backend
# (or a dev instance) already listening on 8080; Bun may share the port
# across processes (SO_REUSEPORT), which routes login and /v1/me to
# different JWT_SECRETs and produces random 401s. Isolate instead.
API_PORT="${WEB_E2E_API_PORT:-8082}"
API="http://localhost:$API_PORT"
WEB="http://localhost:5173"
export JWT_SECRET="${JWT_SECRET:-ci-web-e2e-jwt-secret-0123456789}"
SHOT_DIR="/tmp/soulcloud-web-screenshot"
mkdir -p "$SHOT_DIR"

API_BIND_ADDRESS="127.0.0.1:$API_PORT" bun run start:api > /tmp/ci-web-e2e-api.log 2>&1 &
API_PID=$!
# serve the PRODUCTION build (vite build + preview), not the dev server:
# CI must exercise the actual bundles (chunking, compression, CSP-era
# assets) the nginx container ships
echo "[web-e2e] building the production bundle..."
(cd packages/web && bun run build > /tmp/ci-web-e2e-build.log 2>&1) || {
  echo "[web-e2e] production build failed"; tail -20 /tmp/ci-web-e2e-build.log; exit 1; }
(cd packages/web && VITE_API_TARGET="http://localhost:$API_PORT" bun run preview --port 5173 --strictPort > /tmp/ci-web-e2e-web.log 2>&1) &
WEB_PID=$!

cleanup() {
  # kill the whole process trees we spawned (bun run -> bun/vite -> node
  # layers; plain kill only gets the top wrapper)
  kill_tree() {
    local pid=$1
    for c in $(pgrep -P "$pid" 2>/dev/null || true); do
      kill_tree "$c"
    done
    kill "$pid" 2>/dev/null || true
  }
  kill_tree "$API_PID"
  kill_tree "$WEB_PID"
  agent-browser --session "$SESSION" close --all > /dev/null 2>&1 || true
}
trap cleanup EXIT

echo "[web-e2e] waiting for API..."
for _ in $(seq 1 60); do
  curl -sf "$API/health/ready" > /dev/null 2>&1 && break
  sleep 1
done
curl -sf "$API/health/ready" > /dev/null 2>&1 || {
  echo "[web-e2e] API failed to become ready"; tail -20 /tmp/ci-web-e2e-api.log; exit 1; }

echo "[web-e2e] waiting for web dev server..."
for _ in $(seq 1 60); do
  curl -sf "$WEB/" > /dev/null 2>&1 && break
  sleep 1
done
curl -sf "$WEB/" > /dev/null 2>&1 || {
  echo "[web-e2e] web server failed to start"; tail -20 /tmp/ci-web-e2e-web.log; exit 1; }

echo "[web-e2e] seeding E2E user..."
curl -s -X POST "$API/v1/auth/register" \
  -H 'content-type: application/json' \
  -d '{"username":"e2e-web-user","password":"test-password-123","email":"e2e-web@example.com"}' \
  > /dev/null || true

echo "[web-e2e] API login + device creation..."
LOGIN=$(curl -s -X POST "$API/v1/auth/login" \
  -H 'content-type: application/json' \
  -d '{"username":"e2e-web-user","password":"test-password-123"}')
echo "$LOGIN" > /tmp/e2e-login.json
TOKEN=$(python3 -c "import json;print(json.load(open('/tmp/e2e-login.json'))['access_token'])" 2>/dev/null || echo "")
[ -n "$TOKEN" ] || { echo "[web-e2e] API login failed: $LOGIN"; exit 1; }
curl -s "$API/v1/me" -H "authorization: Bearer $TOKEN" > /tmp/e2e-me.json
PID=$(python3 -c "import json;print(json.load(open('/tmp/e2e-me.json'))['projects'][0]['project_id'])" 2>/dev/null || echo "")
[ -n "$PID" ] || { echo "[web-e2e] /v1/me failed: $(cat /tmp/e2e-me.json)"; exit 1; }
DEV=$(curl -s -X POST "$API/v1/devices" \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d "{\"project_id\":\"$PID\",\"assigned_id\":\"e2e-sensor\",\"device_uid\":\"e2e-uid-1\"}")
echo "$DEV" | python3 -c "import sys,json;d=json.load(sys.stdin);assert d.get('device_id') or d.get('error') == 'device_uid_taken', d" || {
  echo "[web-e2e] device creation failed: $DEV"; exit 1; }
REFRESH=$(python3 -c "import json;print(json.load(open('/tmp/e2e-login.json'))['refresh_token'])")

echo "[web-e2e] running browser flow (single shared session)..."
agent-browser --session "$SESSION" close --all > /dev/null 2>&1 || true

# login page renders (anonymous)
agent-browser --session "$SESSION" open "$WEB/login"
agent-browser --session "$SESSION" wait --text Username --timeout 20000

# inject the session token, then load the dashboard as an authenticated user
agent-browser --session "$SESSION" eval \
  "localStorage.setItem('soulcloud.refresh_token','$REFRESH')" > /dev/null
agent-browser --session "$SESSION" open "$WEB/"
agent-browser --session "$SESSION" wait --text Dashboard --timeout 20000
agent-browser --session "$SESSION" wait --text "e2e-web-user's project" --timeout 20000

# devices page renders the API-created device row
agent-browser --session "$SESSION" open "$WEB/devices"
agent-browser --session "$SESSION" wait --text e2e-sensor --timeout 20000
agent-browser --session "$SESSION" wait --text e2e-uid-1 --timeout 20000

# firmware + rollouts pages render their (empty) states
agent-browser --session "$SESSION" open "$WEB/firmware"
agent-browser --session "$SESSION" wait --text "No releases" --timeout 20000
agent-browser --session "$SESSION" open "$WEB/rollouts"
agent-browser --session "$SESSION" wait --text "No rollouts" --timeout 20000

# logs page: device picker + live xterm terminal view (real-browser check)
# resolve the E2E device's UUID from the API (creation may 409 on re-runs)
DEV_ID=$(curl -s "$API/v1/projects/$PID/devices?limit=100&offset=0" \
  -H "authorization: Bearer $TOKEN" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    print(next((x['device_id'] for x in d.get('devices', []) if x['device_uid'] == 'e2e-uid-1'), ''))
except Exception:
    print('')
" 2>/dev/null || true)
[ -n "$DEV_ID" ] || { echo "[web-e2e] e2e-uid-1 missing from the device list"; exit 1; }

agent-browser --session "$SESSION" open "$WEB/logs"
agent-browser --session "$SESSION" wait --text "Select a device to view the decoded log stream" --timeout 20000
# the device select stays disabled until its list has loaded; wait for
# the DEVICE combobox specifically: the testid rides MUI's native input
# and the [role=combobox] display div is its sibling under the same
# MuiInputBase root (the layout header has its own project combobox, so
# match via the testid)
agent-browser --session "$SESSION" wait --fn "(() => { const input = document.querySelector('[data-testid=device-select]'); const base = input && input.closest('.MuiInputBase-root'); const root = base && base.querySelector('[role=combobox]'); return !!root && !root.hasAttribute('aria-disabled') && root.offsetParent !== null; })()" --timeout 20000
# MUI Select opens on mousedown at the combobox root (the visible
# MuiSelect-select div covers the native input, so clicking the input is
# intercepted); dispatch mousedown on the root directly
agent-browser --session "$SESSION" eval "(() => { const input = document.querySelector('[data-testid=device-select]'); const base = input && input.closest('.MuiInputBase-root'); const root = base && base.querySelector('[role=combobox]'); if (!root) return false; root.scrollIntoView({ block: 'center' }); root.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); return true; })()"
agent-browser --session "$SESSION" wait '[role="option"]' --timeout 10000
agent-browser --session "$SESSION" click "[role=\"option\"][data-value=\"$DEV_ID\"]"
# wait out the menu close transition before interacting again
agent-browser --session "$SESSION" wait --fn "!document.querySelector('[role=listbox]')" --timeout 10000
# table view renders the (empty) history for the E2E device
agent-browser --session "$SESSION" wait --text "No log events" --timeout 20000
# switch to the live xterm terminal view
agent-browser --session "$SESSION" find role button click --name Terminal
# xterm rendered: .xterm container with laid-out .xterm-screen and the
# xterm.css rules applied (computed position relative; a static/zero-size
# terminal means the xterm CSS is missing from the bundle)
agent-browser --session "$SESSION" wait --fn "(() => { const x = document.querySelector('[data-testid=log-terminal] .xterm'); const s = x && document.querySelector('[data-testid=log-terminal] .xterm-screen'); return !!x && getComputedStyle(x).position === 'relative' && !!s && s.getBoundingClientRect().width > 0 })()" --timeout 20000
# live WebSocket log stream reached the server ('ready' frame -> "Connected")
agent-browser --session "$SESSION" wait --text Connected --timeout 30000
agent-browser --session "$SESSION" screenshot "$SHOT_DIR/e2e-terminal.png" > /dev/null

agent-browser --session "$SESSION" screenshot "$SHOT_DIR/e2e-final.png" > /dev/null
echo "[web-e2e] done"
