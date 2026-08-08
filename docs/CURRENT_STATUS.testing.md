# Testing & Quality

**Baseline**: 524 backend tests across 42 files (isolated
`soulcloud_test` DB, `--isolate` per-file processes) + 201 web unit
tests across 33 files, `tsc --noEmit` clean, oxlint clean, and a CI
hard-coded-CJK scan (scripts/scan-hardcoded-i18n.sh) green. E2E scripts
(command loop, log ingestion, OTA, rollout, web <-> API) pass.

## Strategy

- **Unit tests** for deterministic logic: protocol codecs (MessagePack,
  on9log packets, SLIP), the printf/fmt renderer, ELF parsing (synthetic
  ELF builder covering ELF32/64, LE/BE, PT_LOAD, `.noload`, malformed
  inputs), rate limiter (injected clocks), password hashing.
- **Integration tests** against a real PostgreSQL (local Docker or CI
  service): command queue state machine, API endpoints, broker + dispatch,
  LISTEN/NOTIFY.
- **WebSocket stream tests**: real listeners on random ports + real
  `pg_notify` triggers — handshake auth/membership rejection paths,
  debounce merging, max-wait, token-expiry close (4401), connection
  caps, subscriber-key normalization, and "no subscribers never touches
  the database".
- **Terminal sanitize tests**: C0/C1 control characters are stripped
  from device-controlled text before `writeln` (escape-sequence
  injection cannot reach xterm).
- **CI guardrails**: actionlint on `ci.yml` (pinned v1.7.12) and a
  static scan that fails the build on hard-coded CJK outside the i18n
  dictionary.
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
  firmware.test.ts                releases, download JWT, deploy, stall
  rollout.test.ts                 rollout create/detail/lifecycle
  config.test.ts                  JWT_SECRET wiring, fail-fast
packages/broker/tests/mqtt/
  broker.test.ts                  WS auth/ACL/delivery/session kill
  notify.test.ts                  LISTEN/NOTIFY + reconnect
  ota-publish.test.ts             OTA delivery + acks over WS
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

`.github/workflows/ci.yml` (GitHub Actions, `master` branch) runs three
parallel jobs:

1. **backend** (postgres service): install → `db:generate` → `db:deploy`
   → `bun run typecheck` → `bash scripts/test.sh` (524 tests on the
   isolated `soulcloud_test` database) → both-process E2E
   (`scripts/run-e2e.sh`)
2. **web** (no database): install → web typecheck → 201 unit tests
   (`bun run --cwd packages/web test`) → production build
3. **web-e2e** (postgres service): install → `db:generate`/`db:deploy`
   → install agent-browser (Chrome for Testing) →
   `bash scripts/web-e2e-ci.sh` (browser <-> API E2E against a fresh
   database)

## Frontend testing

- **Unit tests**: `bun run --cwd packages/web test` — bun:test with
  happy-dom globals (injected by `src/test-setup.ts`), React Testing
  Library + user-event. Files run with `--isolate` so module mocks
  (`mock.module`) do not leak across files.
- **Coverage**: `bun run --cwd packages/web test --coverage` — 94% lines /
  85% funcs across 33 files (i18n dictionary, axios auth flow,
  contexts, every page/dialog, API helpers, theme).
- **Browser E2E**: `scripts/web-e2e-ci.sh` (needs agent-browser on PATH)
  — starts API + Vite, seeds a user, creates a device via the API, then
  verifies in a real browser that the frontend renders real backend data.
  All browser calls share one agent-browser session; waits are condition
  based (`wait --text`) with no fixed sleeps.

## Scripts

| Script | Purpose |
| --- | --- |
| `scripts/e2e.ts` | command loop E2E (register user → enqueue → WS device receives → result → completed) |
| `scripts/e2e-logging.ts` | logging E2E (register → upload ELF → stat → raw packets → decoded query) |
| `scripts/e2e-ota.ts` | OTA E2E (upload → deploy → MQTT notice → HTTP download → acks → job query) |
| `scripts/e2e-rollout.ts` | rollout E2E (create 2-phase rollout → phase-1 completes → advance loop activates phase 2) |
| `scripts/latency.ts` | enqueue→device latency measurement (LISTEN/NOTIFY wake-up) |
| `scripts/bench-elf.ts` | ELF parser benchmark (36 µs per 1 MB ELF, 40 µs per decoded event) |
| `scripts/web-e2e-ci.sh` | web <-> API E2E: browser renders real backend data (auth, devices, firmware, rollouts) |
| `scripts/prepare-test-db.ts` | create/migrate/truncate the isolated `soulcloud_test` database |
| `scripts/test.sh` | backend test runner (isolated test DB, excludes the web package suite) |
| `scripts/build-on9log-fixtures.sh` | regenerate the checked-in demo ELF + output |
