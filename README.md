# SoulcloudJS

SoulcloudJS is a rewrite of the [Soulcloud](https://github.com/hu/soulcloud) IoT
device-management platform in Bun + TypeScript + Prisma + ElysiaJS with an
embedded [Aedes](https://github.com/moscajs/aedes) MQTT broker.

The original Rust implementation (REST API + MQTT worker as two processes with
an external broker and Diesel ORM) was complex and hard to audit. This rewrite
keeps the two-process separation — REST API and MQTT broker run in separate
processes so their event loops cannot starve each other (the API can scale
horizontally; the broker is a single process today, see
docs/en/architecture.md) — but collapses the shared layer into one small
TypeScript
package with a declarative Prisma schema.

## Workspace layout

```
packages/
  core/     @soulcloud/core    Shared library (not deployable): Prisma client,
                               env config helpers, MQTT topic constants,
                               strict MessagePack codecs, durable command queue
  api/      @soulcloud/api     REST API server (Elysia) for humans: health
                               checks, command batches. No MQTT event loop.
  broker/   @soulcloud/broker  Device-facing MQTT-over-WebSocket broker
                               process (Aedes): device auth/ACL, uplink
                               dispatch, command poller. No HTTP API.
  web/      @soulcloud/web     Human-facing web UI (React 19 + MUI 9 + Vite):
                               device management, logs, firmware, OTA.
```

Both processes share the same PostgreSQL database, which is the only
inter-process channel (durable outbox + polling, no direct IPC):

```
api enqueueBatch ──▶ device_commands (outbox) ──▶ broker leaseNext (poll)
broker publish ──▶ device ──▶ cmd/result ──▶ broker recordDeviceResult
broker writes results ──▶ PostgreSQL ──▶ api queries (future endpoints)
```

A crashed process does not lose work: commands live in PostgreSQL and the
broker recovers by polling and leasing rows (`FOR UPDATE SKIP LOCKED`).
Redis or a message broker will only be introduced when measured load proves
PostgreSQL insufficient; `LISTEN/NOTIFY` may later serve as a wake-up hint
(never as a durable channel).

## Tech stack

| Layer         | Choice                                     |
| ------------- | ------------------------------------------ |
| Runtime       | Bun (workspace monorepo)                   |
| Language      | TypeScript (strict)                        |
| ORM           | Prisma + PostgreSQL                        |
| HTTP          | ElysiaJS (`@soulcloud/api`)                |
| MQTT broker   | Aedes over WebSocket, in `@soulcloud/broker` |
| Serialization | @msgpack/msgpack + strict token validator  |
| Validation    | Zod                                        |
| Web UI        | React 19 + Material UI 9 + Vite (`@soulcloud/web`) |
| Web data      | TanStack Query + axios + react-i18next    |

## Local development

```sh
docker compose up -d --wait postgres
bun install
bun run db:migrate
bun run dev            # starts API + broker with --watch
bun run dev:web        # starts the web UI (Vite, :5173, proxies /v1 to :8080)
```

Run the processes separately if preferred:

```sh
bun run dev:api        # REST API on :8080
bun run dev:broker     # MQTT broker (WS) on :1883/mqtt
```

The Compose PostgreSQL binds only to `127.0.0.1` for development. Stop it with
`docker compose down`; never add `--volumes` unless you explicitly want to erase
local database data.

Health endpoints:

```text
GET /health/live   -> 200 {"status":"ok"}
GET /health/ready  -> 200 {"status":"ready"} or 503 {"status":"not_ready"}
```

Command API:

```text
POST /v1/command-batches
{"device_ids": ["<uuid>", ...], "command": {"cmd": "setLogging", "args": [{"enabled": true}]}}
-> 202 {"batch_id": "<uuid>", "device_count": 2}
```

Error mapping: `400 invalid_targets`, `404 target_devices_not_found`,
`422 invalid_device_uid`, `400 invalid_request`, `500 command_queue_unavailable`.

## Quality checks

```sh
bash scripts/test.sh              # backend: 638 tests on the isolated test DB
bun run --cwd packages/web test   # frontend: 226 unit tests (happy-dom)
bun run typecheck                 # tsc --noEmit (backend + frontend)
bun run --cwd packages/web build  # production build of the web UI
bash scripts/web-e2e-ci.sh        # browser <-> API E2E (needs agent-browser)
bun scripts/e2e.ts                # full-loop smoke test (needs both processes)
```

Backend tests run against their own database (`soulcloud_test`, created and
migrated automatically by `scripts/prepare-test-db.ts`), so the dev MQTT
broker — whose poller leases the global command queue every ~500ms — and
QEMU firmware E2E runs can keep going while tests execute.

Frontend coverage: 94% lines (85% funcs) across 36 test files
(`bun run --cwd packages/web test --coverage`). Backend: 638 tests /
50 files against the isolated test database.

## MQTT v1 topics

| Direction | Topic | Purpose |
| --- | --- | --- |
| Platform to device | `soulcloud/v1/devices/{dev_uid}/ota` | OTA command (per-device download JWT) |
| Platform to device | `soulcloud/v1/devices/{dev_uid}/cmd/exec` | Generic command execution |
| Device to platform | `soulcloud/v1/devices/{dev_uid}/cmd/result` | Generic command result |
| Device to platform | `soulcloud/v1/devices/{dev_uid}/ota/result` | OTA result acknowledgements |
| Device to platform | `soulcloud/v1/devices/{dev_uid}/log` | on9log binary log packets |
| Device to platform | `soulcloud/v1/devices/{dev_uid}/stat` | Device status (validated; `fw` drives firmware state) |
| WebSocket (API → web console) | `GET /v1/ws/logs?device_id=<uuid>` | Realtime decoded log stream (subprotocol auth; see Web UI) |

## Authentication (G group)

**Human users** (REST API): JWT dual-token.

```text
POST /v1/auth/register   {username, password, email}   -> user + personal project
POST /v1/auth/login      {username, password}           -> access + refresh tokens
POST /v1/auth/refresh    {refresh_token}                -> rotated token pair
POST /v1/auth/logout     {refresh_token}                -> revoke
```

- access token: HS256 JWT (default 15 min, stateless)
- refresh token: server-side (SHA-256 stored), default 30 days, revocable,
  rotated on every use; reuse of a rotated token revokes the whole chain
- all command/log/artifact/firmware-state/device-credential endpoints
  require `Authorization: Bearer <access token>`; project-scoped operations
  also require project membership (user_projects)

**Devices** (MQTT): per-session stateful authentication, not JWT.

```text
POST /v1/devices/:id/credentials              issue (password shown once)
POST /v1/devices/:id/credentials/revoke       refuse new connections
```

- device connects with `username = device_uid` (clientId MUST equal it) and
  the issued password; revocation refuses new connections AND kills the
  device's live session (API -> PostgreSQL NOTIFY -> broker kicks the
  Aedes client; if the notification is lost, reconnect is still refused)
- passwords (human + device) are argon2id via Bun.password; legacy scrypt /
  plaintext hashes still verify for development data

## Web UI

The web console (`packages/web`) covers the human-facing workflows:

- **Auth**: login / register (registration creates a personal project),
  session restore, logout. Access token lives in memory only (15 min); the
  refresh token is stored in localStorage, rotated on every use, and a 401
  triggers a single-flight refresh + retry.
- **Devices**: Data Grid list (server pagination), create device (one-time
  MQTT credential), detail page with firmware-state binding, credential
  issue/revoke, command form + history with batch detail.
- **Command history**: `useCommandHistory(deviceId)` gives the command
  form zsh-style ↑/↓ navigation (most recent → oldest; the in-progress
  draft is preserved and restored when reaching the bottom). Committed
  commands are deduped (no consecutive repeats), capped at 50 per device
  and persisted in localStorage (`soulcloud.cmdhistory.<deviceId>`) so
  history survives reloads and never leaks across devices.
- **Logs**: per-device decoded on9log stream with level badges, raw packet
  toggle and 5 s REST auto-refresh.
- **Realtime logs**: `useLogStream(deviceId, {onEvent})` streams decoded
  events over `GET /v1/ws/logs?device_id=<uuid>` (WebSocket). Browsers
  cannot set headers, so auth rides the subprotocol list
  `["soulcloud", "<access token>"]`; the server pushes
  `{type:"ready"}` on open and `{type:"log", device_id, event}` per
  event (same shape as the REST logs endpoint), answers ping/pong
  heartbeats, and the hook reconnects with exponential backoff
  (1 s → 30 s cap). The Logs page has a Table/Terminal view switch: the
  terminal (xterm.js) replays recent history via REST then streams live
  lines with level-colored output, follow/clear controls and dark-mode
  theming. Stream hardening: burst notifies are debounced server-side
  (250 ms merge + max-wait), the access token's expiry is enforced on
  live connections (server closes with `4401 token expired`, the hook
  reconnects with a fresh token), per-process connection caps refuse
  excess sockets (`4401 too many connections`), project membership is
  re-checked for the connection's lifetime (a removed member is closed
  with `4403 access revoked`), and device-controlled terminal text is
  sanitized (C0/C1 stripped) before `writeln`.
- **Firmware**: ELF artifact upload (dictionary import), release upload
  (bin + optional ELF), deploy dialog (multi-select devices -> OTA job),
  authenticated bin download.
- **OTA**: rollout list with progress, creation wizard (auto ratios or
  custom groups, gating parameters), detail page with per-state actions
  (pause/resume/abort/rollback) and a phase stepper.
- **i18n**: Simplified Chinese, English, Russian, Ukrainian, Italian —
  react-i18next for app strings, MUI + Data Grid locales follow the app
  language (browser detection + persisted choice).

CI runs three parallel jobs: backend (typecheck + tests + both-process
E2E), web (typecheck + unit tests + build) and web <-> API browser E2E
(see `scripts/web-e2e-ci.sh`, requires agent-browser). See
`docs/en/web.md` for details.

## Status

Implemented:

- **Command loop**: enqueue commands via HTTP, broker delivers them over
  MQTT QoS 1, terminal results recorded idempotently
- **on9log binary log ingestion**: strict packet parsing, raw event storage,
  ELF artifact upload with SHA-256 build identity, dictionary extraction,
  on-demand decoding at query time (see `docs`)
- **Uplink protection**: per-device rate limits and packet-size caps
- **Human auth**: JWT dual-token (short access + server-side refresh with
  rotation/reuse detection), argon2id passwords, in-process login throttling
- **Device auth**: per-session MQTT (credential issue/revoke, session kill)
- **OTA**: firmware releases (bin + optional ELF), deploy with per-device
  short-JWT download credentials over MQTT, HTTP pull, three-layer target
  state machine (acknowledgements + stat.fw confirmation), phased
  rollouts (auto 5/25/100% or client groups; per-rollout gating settings;
  stall judgement; pause/resume/abort/rollback)

Open (same scope as the Rust version): full-text log search, object
storage archive, retention policies, fleet selectors, org/tenant tenancy
(direct user→project today).

> **Deployment notes**: both backend processes require `JWT_SECRET` (>= 32
> chars, identical for api and broker, see `.env.example`). Login throttling is
> in-process (per instance); register brute-force and OTA download rate
> limiting must be handled at the reverse proxy.

## Production compose

The base `docker compose up -d` starts PostgreSQL, the API, the broker and
the web console:

```sh
# .env must set JWT_SECRET (>= 32 chars)
docker compose up -d --build
# web console: http://localhost:8081 (nginx serves the SPA)
# REST API:    http://localhost:8080
# MQTT (WS):   ws://localhost:1883/mqtt
```

- Images: `Dockerfile.backend` (api/broker targets, multi-stage Bun) and
  `packages/web/Dockerfile` (vite build -> minimal nginx static server).
- The web container serves the built SPA only (SPA fallback + immutable
  asset caching, no proxying inside the container). Compose binds the API
  (`127.0.0.1:8080`), web (`127.0.0.1:8081`) and MQTT
  (`127.0.0.1:1883`) ports to loopback only — plaintext entry points are
  never exposed to other hosts; the reverse proxy in front — traefik in
  the reference deployment — terminates TLS and routes `host/` to the
  web service and `host/v1`, `host/health` to the api service over the
  docker network.
- MQTT-over-WebSocket TLS is likewise expected at the proxy (stream
  passthrough to `:1883`).

### Reverse-proxy mode (traefik)

A reference traefik v3 stack lives in `deploy/traefik/` (file provider,
no docker-provider magic):

```sh
# 1. start the soulcloud services as usual (network <project>_default)
docker compose up -d --build
# 2. start traefik on the same host, joined to that network
#    (edit deploy/traefik/compose.traefik.yaml if the project name differs)
docker compose -f deploy/traefik/compose.traefik.yaml up -d
# 3. set your domain + ACME email in deploy/traefik/*.yaml (example.com)
```

What the proxy does (and what the app deliberately does not):

- **TLS termination** (ACME TLS-ALPN; self-signed example commented in
  `traefik.yaml`) with an HTTP→HTTPS redirect
- **Routing**: `host/` → web (`:8081`), `host/v1` + `host/health` → api
  (`:8080`), `host/mqtt` → broker (`:1883`, WebSocket Upgrade forwarded
  natively; raise `respondingTimeouts` for long-idle devices — commented
  in the config)
- **Rate limiting** on the API routes (register brute-force and OTA
  download bandwidth; see the deployment notes above) and basic security
  headers
- After the proxy is up, remove the base compose port mappings. The broker
  port in particular must NOT stay published: it is plaintext MQTT, so a
  published 1883 lets devices bypass TLS and send credentials over raw WS
  (WEB-04). `deploy/traefik/compose.prod.yaml` is a ready override that
  strips every host port:
  `docker compose -f compose.yaml -f deploy/traefik/compose.prod.yaml up -d`
  The public entry points then are `https://<domain>/`, `https://<domain>/v1`
  and `wss://<domain>/mqtt`; devices MUST use `wss://` (plaintext `ws://`
  only ever reaches the loopback mapping for local diagnostics).

## Log ingestion quick tour

```sh
# upload a firmware ELF (extracts the on9log string dictionary)
curl -F "project_id=<uuid>" -F "file=@firmware.elf" \
     http://localhost:8080/v1/firmware-artifacts

# devices publish on9log packets (raw, or MsgPack bundles of packets — see
# docs/en/protocol-log-packaging.md) to soulcloud/v1/devices/{uid}/log;
# a stat message with fw=<firmware hash> links logs to the artifact

# query logs (decoded on demand)
curl "http://localhost:8080/v1/devices/<uuid>/logs?limit=100"
```
