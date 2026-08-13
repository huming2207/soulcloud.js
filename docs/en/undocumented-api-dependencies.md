# Undocumented API Dependencies

**Status**: 2026-08-13 · This page lists every place the codebase depends on
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
| E1 | `ws.data.headers["sec-websocket-protocol"]` and `ws.data.query` — Elysia injects these into the Bun socket data before the ws handlers run; keys are lowercase | 5 stream files (~15 sites) | Subprotocol token / query params become unreadable → handshakes start rejecting valid clients (loud, tests catch it) |
| E2 | `ElysiaWS.raw` — every ws event receives a NEW ElysiaWS wrapper around the stable Bun socket; the wrapper's `raw` property is the identity used for Set/WeakMap keys | `ws-access.ts` `rawSocket()`; all 5 streams use it | Cleanup never matches → leaked subscriber entries, stale connection counters (silent, tests catch it) |
| E3 | `beforeHandle` rejection semantics — a 4xx status set in `beforeHandle` aborts the upgrade with a plain HTTP response; the handler's return value is DISCARDED by the Bun adapter (verified against `dist/adapter/bun/index.js`, Elysia 1.4.29) | All 5 WS routes | Unauthenticated sockets could start being accepted silently — pinned by the raw-HTTP upgrade probes in `log-stream.test.ts` ("handshake rejection semantics") |
| E4 | `app.server.port` — the listen() return exposes the underlying server with the ACTUAL bound port (`port: 0` support) | Test files only (6 sites) | Tests cannot discover the random port |

### Bun runtime

| # | Dependency | Where | What breaks if it changes |
| --- | --- | --- | --- |
| B1 | `ws.send()` return value: `0` = connection unusable (real failure), `-1` = queued with backpressure (NOT a failure), `>= 0` = queued — the WS adapter only treats `0` as an error. Bun's docs do not spell this contract out; it was verified empirically. | `packages/broker/src/mqtt/ws-adapter.ts` (write side) | Healthy connections torn down under load (`-1` misread as failure) or dead connections not detected (`0` ignored) |

### Prisma 7

| # | Dependency | Where | What breaks if it changes |
| --- | --- | --- | --- |
| P1 | Unique-violation field extraction reads `meta.driverAdapterError.cause.constraint.fields` (driver-adapter internal shape); the code also handles the documented `meta.target` format as a fallback | `packages/api/src/api/devices.ts` `uniqueViolationFields()` | 409 error mapping degrades from `<field>_taken` to a generic 409 — graceful, not a crash |
| P2 | Error code `P2002` (unique constraint) — this IS documented; listed for completeness | `devices.ts`, `auth.ts`, `core/src/logging/artifact.ts` | Idempotency/conflict handling breaks loudly |

### mqtt-packet (test helper + broker write side)

| # | Dependency | Where | What breaks if it changes |
| --- | --- | --- | --- |
| M1 | `writeToStream` emits one MQTT control packet as SEVERAL `stream.write()` calls (header, flags, payload); the WS adapter's `MqttFrameBuffer` reassembles them into one complete frame per WS message (MQTT-over-WS framing requirement) | `packages/broker/src/mqtt/ws-adapter.ts` | Malformed WS frames sent to devices → device-side parser failures |

## Upgrade checklist

1. **Bun**: verify B1 against the new version's docs/changelog; run the broker WS tests (`broker.test.ts`, `publish.test.ts`, `connection-registry.test.ts`) plus a real device connect/disconnect smoke.
2. **Elysia**: verify E1–E3 by running `log-stream.test.ts` (handshake rejection probes + full WS flows). If the major version bumps, re-read the bun adapter source for the `beforeHandle` short-circuit and the ElysiaWS wrapper shape.
3. **Aedes**: no internal structures read; only the event contract (`client` after auth, `clientDisconnect` ordering vs. same-clientId replacement, `subscribe`/`unsubscribe` payload shapes) matters — the connection-registry tests pin all of it.
4. **Prisma**: P1's driver-adapter shape is best-effort; confirm the fallback path works if the shape changed (test: create a device with a duplicate `device_uid` and expect `device_uid_taken`).
5. **mqtt-packet**: M1 — broker WS tests with a real client round-trip cover the framing.

## History

- 2026-08-13: Aedes internals cleared (connection registry). Page created.
