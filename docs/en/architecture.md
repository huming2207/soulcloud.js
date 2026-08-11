# Architecture

## Overview

SoulcloudJS is a Bun workspace monorepo with three packages:

```
soulcloudjs/ (Bun workspace)
├── packages/core/    @soulcloud/core     Shared library (not deployable)
├── packages/api/     @soulcloud/api     REST API server (Elysia, :8080)
└── packages/broker/  @soulcloud/broker   MQTT-over-WebSocket broker (Aedes, :1883/mqtt)
```

Two deployable processes, one shared library — mirroring the original Rust
layout (api + worker + core) but with the broker embedded instead of an
external MQTT server.

## Why two processes (not one)

- **Event-loop isolation**: Bun is single-threaded per process. MQTT routing
  and HTTP traffic must not starve each other; with real device counts, a
  shared event loop degrades both.
- **Independent scaling**: the API and the broker are separate processes and
  can be scaled independently of each other (e.g. API replicas behind the
  reverse proxy).
- **Single-broker constraint**: the broker currently runs as **one process**.
  The durable command/OTA queues use PostgreSQL lease locking (`FOR UPDATE
  SKIP LOCKED`) and would be safe across instances, but Aedes session state
  (connections, subscriptions) is process-local: a second broker instance
  could lease a command for a device connected to another instance, judge it
  offline and defer it (correct, but slow and churny), and a restart drops all
  live sessions. Device-to-broker ownership/partitioning or a cluster-aware
  broker is required before advertising horizontal broker scaling.
- **Failure isolation**: a broker crash does not take down the web API.

## Inter-process communication

There is deliberately **no direct IPC**. PostgreSQL is the only channel:

```
api enqueueBatch ──▶ device_commands (durable outbox)
                          │
broker leaseNext ◀── (poll every 500ms, or LISTEN/NOTIFY wake-up)
                          │
broker aedes.publish ──▶ device ──▶ cmd/result
                          │
broker recordDeviceResult ──▶ device_commands (result fields)
```

- `LISTEN/NOTIFY` (`soulcloud_commands`) is a **lossy wake-up hint** only:
  the poller always recovers from the durable rows. Dropped notifications
  cost latency, never correctness.
- `LISTEN/NOTIFY` (`soulcloud_credentials_revoked`) wakes the broker to kill
  a revoked device's live session; if lost, the revocation still refuses
  reconnects.
- Redis / message brokers are intentionally absent; they will be introduced
  only when measured load proves PostgreSQL insufficient.

## Process boundaries

| Component | Owns | Forbidden |
| --- | --- | --- |
| `@soulcloud/api` | REST API, auth (JWT), device credential management, ELF upload, log queries, rollout advance loop (DB-only poller) | No MQTT event loop, no direct device connections |
| `@soulcloud/broker` | Aedes broker, device auth/ACL, uplink dispatch, command poller, session kill | No human-facing HTTP API |
| `@soulcloud/core` | Prisma client, protocol codecs, queue logic, on9log parsing, ELF parsing, password/auth primitives | Not deployable |

## Key files

- `packages/core/src/index.ts` — public surface of the shared library
- `packages/core/src/db.ts` — Prisma client singleton (the only import of the
  generated client)
- `packages/api/src/index.ts` — API entry; binds host:port (IPv6 supported),
  graceful shutdown via `app.stop()`
- `packages/broker/src/index.ts` — broker entry; wires broker + dispatch +
  poller + notifier
- `packages/broker/src/mqtt/ws-adapter.ts` — Bun-native WebSocket transport
  (see MQTT broker document)

## Configuration

Environment variables are validated with Zod at startup (typed, actionable
failures). See `.env.example`; required: `DATABASE_URL`. API adds `JWT_*`;
broker adds `MQTT_*`, `COMMAND_*`, `UPLINK_*`.

## Development

```sh
docker compose up -d --wait postgres
bun install
bun run db:migrate     # or db:deploy
bun run dev            # api + broker with --watch
bun test               # 243 tests
bun run typecheck      # tsc --noEmit
```
