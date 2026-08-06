# SoulcloudJS — Current Status

**Date**: 2026-08-06 · **Baseline**: 398 backend tests + 115 web unit tests
green, `tsc --noEmit` clean, backend + browser E2E suites pass, CI runs
three parallel jobs (backend / web / web-e2e).

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
| [CURRENT_STATUS.web.md](CURRENT_STATUS.web.md) | Web console: stack, auth flow, pages, i18n, tests |

## Quick facts

- **Runtime**: Bun 1.3, TypeScript strict, zero native deps (only `jose`, `pg`,
  `elysia`, `zod`, `aedes`, `@msgpack/msgpack`, `mqtt-packet` as test helper).
- **Processes**: `@soulcloud/api` (REST, :8080), `@soulcloud/broker`
  (MQTT over WebSocket, :1883/mqtt) and `@soulcloud/web` (SPA, Vite :5173
  in dev) — two backend processes, one PostgreSQL, one browser UI.
- **Inter-process communication**: PostgreSQL only (durable outbox + lease
  polling; LISTEN/NOTIFY as a lossy wake-up).
- **Protocol**: MQTT 3.1.1 over WebSocket; MessagePack payloads for commands;
  raw on9log packets for logs.
- **Auth**: humans use JWT dual-token (access + server-side refresh); devices
  use per-session MQTT authentication (never JWT).
- **Web UI**: React 19 + Material UI 9, five locales (zh/en/ru/uk/it),
  115 unit tests + browser E2E.
- **OTA**: releases → deploy (per-device JWT over MQTT, HTTP pull) →
  three-layer target state machine → phased rollouts with gating/stall
  judgement/rollback.
