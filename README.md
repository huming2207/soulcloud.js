# SoulcloudJS

SoulcloudJS is a rewrite of the [Soulcloud](https://github.com/hu/soulcloud) IoT
device-management platform in Bun + TypeScript + Prisma + ElysiaJS with an
embedded [Aedes](https://github.com/moscajs/aedes) MQTT broker.

The original Rust implementation (REST API + MQTT worker as two processes with
an external broker and Diesel ORM) was complex and hard to audit. This rewrite
keeps the two-process separation — REST API and MQTT broker run in separate
processes so their event loops cannot starve each other and they scale
independently — but collapses the shared layer into one small TypeScript
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
bash scripts/test.sh    # 398 tests, isolated test database (soulcloud_test)
bun run typecheck       # tsc --noEmit
bun run db:deploy       # apply migrations
bun scripts/e2e.ts      # full-loop smoke test (needs both processes running)
```

The test suite runs against its own database (`soulcloud_test`, created and
migrated automatically by `scripts/prepare-test-db.ts`), so the dev MQTT
broker — whose poller leases the global command queue every ~500ms — and
QEMU firmware E2E runs can keep going while tests execute.

## MQTT v1 topics

| Direction | Topic | Purpose |
| --- | --- | --- |
| Platform to device | `soulcloud/v1/devices/{dev_uid}/ota` | OTA command (not yet implemented) |
| Platform to device | `soulcloud/v1/devices/{dev_uid}/cmd/exec` | Generic command execution |
| Device to platform | `soulcloud/v1/devices/{dev_uid}/cmd/result` | Generic command result |
| Device to platform | `soulcloud/v1/devices/{dev_uid}/log` | Log events (contract not yet defined) |
| Device to platform | `soulcloud/v1/devices/{dev_uid}/stat` | Device status (validated, not yet persisted) |

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

> **Deployment notes**: both processes require `JWT_SECRET` (>= 32 chars,
> identical for api and broker, see `.env.example`). Login throttling is
> in-process (per instance); register brute-force and OTA download rate
> limiting must be handled at the reverse proxy.

## Log ingestion quick tour

```sh
# upload a firmware ELF (extracts the on9log string dictionary)
curl -F "project_id=<uuid>" -F "file=@firmware.elf" \
     http://localhost:8080/v1/firmware-artifacts

# devices publish raw on9log packets to soulcloud/v1/devices/{uid}/log;
# a stat message with fw=<firmware hash> links logs to the artifact

# query logs (decoded on demand)
curl "http://localhost:8080/v1/devices/<uuid>/logs?limit=100"
```
