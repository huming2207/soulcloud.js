# SoulcloudJS

SoulcloudJS is a rewrite of the [Soulcloud](https://github.com/hu/soulcloud) IoT
device-management platform in Bun + TypeScript + Prisma + ElysiaJS with an
embedded [Aedes](https://github.com/moscajs/aedes) MQTT broker.

The original Rust implementation (2 processes: REST API + MQTT worker, external
MQTT broker, Diesel ORM) was complex and hard to audit. This rewrite collapses
it into a **single process** with an embedded broker, a declarative Prisma
schema, and a much smaller codebase.

## Tech stack

| Layer        | Choice                                    |
| ------------ | ----------------------------------------- |
| Runtime      | Bun                                       |
| Language     | TypeScript (strict)                       |
| ORM          | Prisma + PostgreSQL                       |
| HTTP         | ElysiaJS                                  |
| MQTT broker  | Aedes (embedded, in-process)              |
| Serialization| @msgpack/msgpack                          |
| Validation   | Zod                                       |

## Architecture

```
┌─────────────────────────────────────────────────┐
│                  SoulcloudJS                     │
│                                                  │
│  ┌──────────────┐  ┌──────────────────────────┐ │
│  │ ElysiaJS API │  │   Aedes MQTT Broker      │ │
│  │  :8080       │  │   :1883 (TCP MQTT)       │ │
│  └──────┬───────┘  └───────────┬───────────────┘ │
│         └──────────┬───────────┘                  │
│              ┌─────┴─────┐                       │
│              │ Prisma +   │                       │
│              │ PostgreSQL │                       │
│              └───────────┘                       │
└─────────────────────────────────────────────────┘
```

Single process: the API server embeds the MQTT broker and shares one Prisma
connection pool. There is no separate worker process and no external broker
dependency.

## Local development

```sh
docker compose up -d --wait postgres
bunx prisma migrate dev
bun run dev
```

The Compose PostgreSQL binds only to `127.0.0.1` for development. Stop it with
`docker compose down`; never add `--volumes` unless you explicitly want to erase
local database data.

Health endpoints:

```text
GET /health/live   -> 200 {"status":"ok"}
GET /health/ready  -> 200 {"status":"ready"} or 503 {"status":"not_ready"}
```

## Project layout

```
src/
  index.ts        # Entry: Prisma -> Aedes -> Elysia
  config.ts       # Environment variable parsing (Zod)
  db.ts           # Prisma client singleton
  protocol/       # MQTT topics + MessagePack codecs
  queue/          # Durable command queue
  mqtt/           # Aedes broker, dispatch, publish
  api/            # REST routes
tests/
  protocol/       # Topic + codec unit tests
  queue/          # DB integration tests
  mqtt/           # Broker integration tests
  api/            # API end-to-end tests
prisma/
  schema.prisma
  migrations/
```

## Environment variables

See `.env.example`. Required: `DATABASE_URL`. Optional with defaults:
`API_BIND_ADDRESS` (0.0.0.0:8080), `MQTT_BROKER_PORT` (1883),
`MQTT_COMMAND_RETAIN` (false), `COMMAND_POLL_INTERVAL_MS` (500),
`COMMAND_LEASE_SECONDS` (60), `LOG_LEVEL` (info).

## MQTT v1 topics

| Direction | Topic | Purpose |
| --- | --- | --- |
| Platform to device | `soulcloud/v1/devices/{dev_uid}/ota` | OTA command (not yet implemented) |
| Platform to device | `soulcloud/v1/devices/{dev_uid}/cmd/exec` | Generic command execution |
| Device to platform | `soulcloud/v1/devices/{dev_uid}/cmd/result` | Generic command result |
| Device to platform | `soulcloud/v1/devices/{dev_uid}/log` | Log events (contract not yet defined) |
| Device to platform | `soulcloud/v1/devices/{dev_uid}/stat` | Device status (validated, not yet persisted) |

## Status

Scaffold in progress. See the plan in `/home/hu/Projects/llm-docs/soulcloudjs`.
