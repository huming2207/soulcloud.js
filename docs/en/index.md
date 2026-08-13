# SoulcloudJS — Current Status

**Date**: 2026-08-13 · **Baseline**: 638 backend tests + 226 web unit tests
green, `tsc --noEmit` clean, backend + browser E2E suites pass, CI runs
three parallel jobs (backend / web / web-e2e).

SoulcloudJS is a rewrite of the Rust Soulcloud IoT device-management platform in
Bun + TypeScript. This document set describes what exists today, how it works,
and what is deliberately left open.

## Topics

| Document | Covers |
| --- | --- |
| [architecture.md](architecture.md) | Workspace layout, processes, inter-process communication |
| [database.md](database.md) | PostgreSQL schema, migrations, constraints |
| [mqtt-broker.md](mqtt-broker.md) | MQTT-over-WebSocket broker, topics, device auth/ACL, WS adapter |
| [command-queue.md](command-queue.md) | Durable command state machine, leases, delivery timeouts |
| [logging.md](logging.md) | on9log binary log ingestion, ELF artifacts, decoding |
| [protocol-log-packaging.md](protocol-log-packaging.md) | Firmware-facing log uplink packaging spec: dispatch container (0x9a raw / 0x01 MessagePack array), byte-level examples |
| [rest-api.md](rest-api.md) | REST endpoints, error mapping, pagination |
| [authentication.md](authentication.md) | Human JWT dual-token auth, device per-session auth, credentials |
| [security.md](security.md) | Threat model, DDoS guards, audit history (3 review rounds) |
| [testing.md](testing.md) | Test strategy, fixtures, CI |
| [web.md](web.md) | Web console: stack, auth flow, pages, i18n, tests |
| [undocumented-api-dependencies.md](undocumented-api-dependencies.md) | Every non-contract dependency (Elysia/Bun/Prisma/mqtt-packet internals) + the upgrade checklist |

## Quick facts

- **Runtime**: Bun 1.3, TypeScript strict, zero native deps (only `jose`, `pg`,
  `elysia`, `zod`, `aedes`, `@msgpack/msgpack`, `mqtt-packet` as test helper).
- **Processes**: `@soulcloud/api` (REST, :8080), `@soulcloud/broker`
  (MQTT over WebSocket, :1883/mqtt) and `@soulcloud/web` (SPA, Vite :5173
  in dev) — two backend processes, one PostgreSQL, one browser UI.
- **Inter-process communication**: PostgreSQL only (durable outbox + lease
  polling; LISTEN/NOTIFY as a lossy wake-up).
- **Protocol**: MQTT 3.1.1 over WebSocket; MessagePack payloads for commands;
  raw on9log packets for logs (single packets or MsgPack bundles — see
  [protocol-log-packaging.md](protocol-log-packaging.md)).
- **Auth**: humans use JWT dual-token (access + server-side refresh); devices
  use per-session MQTT authentication (never JWT).
- **Web UI**: React 19 + Material UI 9, five locales (zh/en/ru/uk/it),
  221 unit tests + browser E2E.
- **OTA**: releases → deploy (per-device JWT over MQTT, HTTP pull) →
  three-layer target state machine → phased rollouts with gating/stall
  judgement/rollback.
