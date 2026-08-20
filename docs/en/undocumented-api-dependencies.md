# Undocumented API Dependencies

**Status**: 2026-08-21 · This page lists every place the codebase depends on
behavior that is NOT part of a dependency's documented public contract:
internal object shapes, implementation-specific event ordering, or
under-documented runtime semantics. Before upgrading Bun / Elysia / Aedes /
Prisma, walk this list and verify each item against the new version.

## Cleared areas

| Dependency | Area | Status |
| --- | --- | --- |
| Aedes | `aedes.clients`, `client.subscriptions` (internal structures) | **Removed 2026-08-13** — replaced by the connection registry (`packages/broker/src/mqtt/connection-registry.ts`), built only from documented events (`client`, `clientDisconnect`, `subscribe`, `unsubscribe`) plus the `authorizeSubscribe` hook. No production code reads aedes internals anymore. |

## Active dependencies

### Elysia 1.4 (WS streams, `packages/api/src/api/*-stream.ts`)

| # | Dependency | Where | What breaks if it changes |
| --- | --- | --- | --- |
| E1 | `ws.data.headers["sec-websocket-protocol"]` and `ws.data.query` — Elysia injects these into the Bun socket data before the ws handlers run; keys are lowercase | Direct reads in 2 stream files (4 sites: log-stream, status-stream); all 5 streams additionally read the subprotocol via `beforeHandle`'s `request.headers.get(...)` | Subprotocol token / query params become unreadable → handshakes start rejecting valid clients (loud, tests catch it) |
| E2 | `ElysiaWS.raw` — every ws event receives a NEW ElysiaWS wrapper around the stable Bun socket; the wrapper's `raw` property is the identity used for Set/WeakMap keys | `ws-access.ts` `rawSocket()`; all 5 streams use it | Cleanup never matches → leaked subscriber entries, stale connection counters (silent, tests catch it) |
| E3 | `beforeHandle` rejection semantics — a 4xx status set in `beforeHandle` aborts the upgrade with a plain HTTP response. The abort happens in Elysia's COMPOSE layer (beforeHandle is a route hook; a truthy return short-circuits to a normal HTTP response); the Bun adapter discards the handler's return value on the success path only (verified against `dist/adapter/bun/index.js`, Elysia 1.4.29) | All 5 WS routes | Unauthenticated sockets could start being accepted silently — pinned by the raw-HTTP upgrade probes in `log-stream.test.ts` ("handshake rejection semantics") |
| E5 | On a SUCCESSFUL handshake, `beforeHandle` runs TWICE (compose chain + adapter, each with its own DB auth round-trip) — the streams rely on it being idempotent | All 5 WS routes | Harmless today; an Elysia upgrade that deduplicates the second call is a behavior change (fewer queries), not a break |
| E4 | `app.server.port` — the listen() return exposes the underlying server with the ACTUAL bound port (`port: 0` support) | Test files only (14 sites across 5 test files) | Tests cannot discover the random port |

### Bun runtime

| # | Dependency | Where | What breaks if it changes |
| --- | --- | --- | --- |
| B1 | `ws.send()` return value: `0` = connection unusable (real failure), `-1` = queued with backpressure, `> 0` = bytes queued. The adapter treats `0` as an error and defers the stream write callback after `-1` until Bun's `drain` callback | `packages/broker/src/mqtt/ws-adapter.ts` (write side) | Healthy connections torn down (`-1` misread as failure), dead connections ignored (`0` ignored), or the 16 MiB per-socket queue overfilled (write callback released before `drain`) |
| B2 | Bun 1.4 `--isolate` resets globals between test files in the same process; only explicit `--parallel` adds worker processes | Root and web test scripts | Assuming process isolation hides leaked handles; enabling `--parallel` lets independent backend workers lease another test's shared queue rows |

### Prisma 7

| # | Dependency | Where | What breaks if it changes |
| --- | --- | --- | --- |
| P1 | Unique-violation field extraction tries the documented `meta.target` format FIRST, then falls back to `meta.driverAdapterError.cause.constraint.fields` (driver-adapter internal shape) | `packages/api/src/api/devices.ts` `uniqueViolationFields()` | 409 error mapping degrades from `<field>_taken` to a generic 409 — graceful, not a crash |
| P2 | Error code `P2002` (unique constraint) — this IS documented; listed for completeness | `devices.ts`, `auth.ts`, `core/src/logging/artifact.ts` | Idempotency/conflict handling breaks loudly |

### mqtt-packet (test helper + broker write side)

| # | Dependency | Where | What breaks if it changes |
| --- | --- | --- | --- |
| M1 | `writeToStream` emits one MQTT control packet as several `stream.write()` calls (header, flags, payload); the adapter coalesces them into one outbound WS message to reduce framing and embedded-client wakeups (MQTT itself permits partial/multiple packets per message) | `packages/broker/src/mqtt/ws-adapter.ts` | More WS frames and receiver wakeups if mqtt-packet's write pattern changes; protocol correctness is unaffected |

## Upgrade checklist

1. **Bun**: verify B1/B2 against the new version's docs/changelog; run the broker WS tests (`ws-adapter.test.ts`, `broker.test.ts`, `publish.test.ts`, `connection-registry.test.ts`) plus a real device connect/disconnect smoke. Do not enable backend `--parallel` without first removing its shared queue-row interference.
2. **Elysia**: verify E1–E5 by running `log-stream.test.ts` (handshake rejection probes + full WS flows). If the major version bumps, re-read BOTH the compose short-circuit and the bun adapter source (the `beforeHandle` abort lives in compose; the adapter discards return values on the success path and wraps each event in a new ElysiaWS).
3. **Aedes**: no internal structures read; only the event contract (`client` after auth, `clientDisconnect` ordering vs. same-clientId replacement, `subscribe`/`unsubscribe` payload shapes) matters — the connection-registry tests pin all of it.
4. **Prisma**: P1's driver-adapter shape is best-effort; confirm the fallback path works if the shape changed (test: create a device with a duplicate `device_uid` and expect `device_uid_taken`).
5. **mqtt-packet**: M1 — broker WS tests with a real client round-trip cover the framing.

## History

- 2026-08-13: Aedes internals cleared (connection registry). Page created.
- 2026-08-21: Bun 1.4 verification confirmed B1/B2; adapter tests now pin
  fragmented inbound MQTT packets and write-callback backpressure. API WS
  tests observe strict close codes and await `stop(true)` cleanup. The
  Bun-native MQTT adapter remains required because `mqtt.js` still calls the
  unsupported `createWebSocketStream` path under Bun 1.4.
