# SoulcloudJS — Current Status

**Date**: 2026-08-04 · **Baseline**: 243 tests / 19 files green, `tsc --noEmit` clean, both E2E suites pass.

SoulcloudJS is a rewrite of the Rust Soulcloud IoT device-management platform in
Bun + TypeScript. This document set describes what exists today, how it works,
and what is deliberately left open.

## Topics

| Document | Covers |
| --- | --- |
| [CURRENT_STATUS.architecture.md](CURRENT_STATUS.architecture.md) | Workspace layout, processes, inter-process communication |
| [CURRENT_STATUS.database.md](CURRENT_STATUS.database.md) | PostgreSQL schema, migrations, constraints |
| [CURRENT_STATUS.mqtt-broker.md](CURRENT_STATUS.mqtt-broker.md) | MQTT-over-WebSocket broker, topics, device auth/ACL, WS adapter |
| [CURRENT_STATUS.command-queue.md](CURRENT_STATUS.command-queue.md) | Durable command state machine, leases, delivery timeouts |
| [CURRENT_STATUS.logging.md](CURRENT_STATUS.logging.md) | on9log binary log ingestion, ELF artifacts, decoding |
| [CURRENT_STATUS.rest-api.md](CURRENT_STATUS.rest-api.md) | REST endpoints, error mapping, pagination |
| [CURRENT_STATUS.authentication.md](CURRENT_STATUS.authentication.md) | Human JWT dual-token auth, device per-session auth, credentials |
| [CURRENT_STATUS.security.md](CURRENT_STATUS.security.md) | Threat model, DDoS guards, audit history (3 review rounds) |
| [CURRENT_STATUS.testing.md](CURRENT_STATUS.testing.md) | Test strategy, fixtures, CI |

## Quick facts

- **Runtime**: Bun 1.3, TypeScript strict, zero native deps (only `jose`, `pg`,
  `elysia`, `zod`, `aedes`, `@msgpack/msgpack`, `mqtt-packet` as test helper).
- **Processes**: `@soulcloud/api` (REST, :8080) and `@soulcloud/broker`
  (MQTT over WebSocket, :1883/mqtt) — two processes, one PostgreSQL.
- **Inter-process communication**: PostgreSQL only (durable outbox + lease
  polling; LISTEN/NOTIFY as a lossy wake-up).
- **Protocol**: MQTT 3.1.1 over WebSocket; MessagePack payloads for commands;
  raw on9log packets for logs.
- **Auth**: humans use JWT dual-token (access + server-side refresh); devices
  use per-session MQTT authentication (never JWT).
