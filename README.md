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
  broker/   @soulcloud/broker  Device-facing MQTT broker process (Aedes):
                               device auth/ACL, uplink dispatch, command
                               publication poller. No HTTP API.
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
| MQTT broker   | Aedes, embedded in `@soulcloud/broker`     |
| Serialization | @msgpack/msgpack + strict token validator  |
| Validation    | Zod                                        |

## Local development

```sh
docker compose up -d --wait postgres
bun install
bun run db:migrate
bun run dev            # starts API + broker with --watch
```

Run the processes separately if preferred:

```sh
bun run dev:api        # REST API on :8080
bun run dev:broker     # MQTT broker on :1883
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
bun test              # 61 tests: protocol, queue, broker, api
bun run typecheck     # tsc --noEmit
bun run db:deploy     # apply migrations
bun scripts/e2e.ts    # full-loop smoke test (needs both processes running)
```

## MQTT v1 topics

| Direction | Topic | Purpose |
| --- | --- | --- |
| Platform to device | `soulcloud/v1/devices/{dev_uid}/ota` | OTA command (not yet implemented) |
| Platform to device | `soulcloud/v1/devices/{dev_uid}/cmd/exec` | Generic command execution |
| Device to platform | `soulcloud/v1/devices/{dev_uid}/cmd/result` | Generic command result |
| Device to platform | `soulcloud/v1/devices/{dev_uid}/log` | Log events (contract not yet defined) |
| Device to platform | `soulcloud/v1/devices/{dev_uid}/stat` | Device status (validated, not yet persisted) |

## Status

Core loop implemented: enqueue commands via HTTP, broker delivers them over
MQTT QoS 1, terminal results are recorded idempotently. Auth (user/org/tenant),
OTA, log ingestion, stat persistence and fleet selectors remain open (same
scope as the Rust version).
