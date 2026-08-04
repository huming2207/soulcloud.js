# Testing & Quality

**Baseline**: 243 tests across 19 files, `bun test` green, `tsc --noEmit`
clean. E2E scripts (command loop + log ingestion) pass against both running
processes.

## Strategy

- **Unit tests** for deterministic logic: protocol codecs (MessagePack,
  on9log packets, SLIP), the printf/fmt renderer, ELF parsing (synthetic
  ELF builder covering ELF32/64, LE/BE, PT_LOAD, `.noload`, malformed
  inputs), rate limiter (injected clocks), password hashing.
- **Integration tests** against a real PostgreSQL (local Docker or CI
  service): command queue state machine, API endpoints, broker + dispatch,
  LISTEN/NOTIFY.
- **Real-device-equivalent tests**: a mini MQTT-over-WebSocket client
  (`packages/broker/tests/helpers/mqtt-client.ts`) built on Bun's native
  WebSocket + `mqtt-packet` (mqtt.js's WS transport is broken under Bun).
- **Real firmware fixtures**: the compiled on9log Unix demo ELF (~1 MB) and
  its SLIP output are checked in under `packages/core/tests/fixtures/` —
  zero `/tmp` dependencies, zero silent skips. Regenerate with
  `scripts/build-on9log-fixtures.sh`.
- **Synthetic fixtures** elsewhere: `tests/helpers/elf-builder.ts` builds
  minimal ELFs; logging tests hand-craft on9log packets matching the
  synthetic ELF addresses.

## Test layout

```
packages/core/tests/
  topic/command/stat.test.ts      protocol codecs
  protocol/structure.test.ts      MessagePack depth/duplicates
  on9log/packet|render|slip.test.ts
  on9log/demo-integration.test.ts real firmware output + ELF
  elf/parser|elf64.test.ts        synthetic ELF suites
  queue/queue|rate-limit.test.ts  queue state machine, limiter
  logging/logging.test.ts         ingestion/decoding/backfill (synthetic)
  security/password.test.ts       argon2id only
packages/api/tests/api/
  auth.test.ts                    JWT flow, rotation, revocation
  commands.test.ts                batch API + errors + authz
  logging.test.ts                 artifacts, logs, credentials
packages/broker/tests/mqtt/
  broker.test.ts                  WS auth/ACL/delivery/session kill
  notify.test.ts                  LISTEN/NOTIFY + reconnect
```

## Reliability practices

- **No fixed sleeps** for asynchronous DB assertions: `waitFor()` polls a
  predicate with a timeout (except genuine reconnect delays, which are
  polled too)
- **Test isolation**: cleanup is scoped to test devices/projects — no
  global `DELETE FROM ...` that would race across files (bun test runs
  files in parallel)
- **Skipped tests do not exist**: every test runs for real (fixtures are
  checked in)
- Tests fail on internal error leaks (`500` responses assert the body does
  not contain internal messages)

## CI

`.github/workflows/ci.yml` (GitHub Actions, `master` branch):

1. checkout + setup-bun
2. `bun install --frozen-lockfile`
3. `bun run db:generate` (generated client is gitignored — without this CI
   fails)
4. `bun run db:deploy` against a postgres:18-alpine service
5. `bun run typecheck`
6. `bun test`

E2E scripts are not in CI (they need both processes and a firmware ELF);
they are run locally as part of a release check.

## Scripts

| Script | Purpose |
| --- | --- |
| `scripts/e2e.ts` | command loop E2E (register user → enqueue → WS device receives → result → completed) |
| `scripts/e2e-logging.ts` | logging E2E (register → upload ELF → stat → raw packets → decoded query) |
| `scripts/latency.ts` | enqueue→device latency measurement (LISTEN/NOTIFY wake-up) |
| `scripts/bench-elf.ts` | ELF parser benchmark (36 µs per 1 MB ELF, 40 µs per decoded event) |
| `scripts/build-on9log-fixtures.sh` | regenerate the checked-in demo ELF + output |
