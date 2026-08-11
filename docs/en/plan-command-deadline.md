# Command Delivery Deadline — Design Decision

**Date**: 2026-08-11 · **Status**: proposal (nothing implemented) · **Audience**:
platform decision-makers · **Origin**: GPT/Codex review WEB-01 (follow-up item)

## 1. Problem

Commands have no default application-result deadline. `enqueueBatch`
(`packages/core/src/queue/enqueue.ts:39-46`) stores `deliveryExpiresAt = null`
unless the caller passes `deliveryTimeoutSeconds`; the web console
(`packages/web/src/components/CommandPanel.tsx:100,119-139`) leaves the
timeout field blank by default and omits `delivery_timeout_seconds`.

Once a command is `broker_accepted` it is never leased again
(`packages/core/src/queue/lease.ts:74-89` — the per-device NOT EXISTS guard
blocks later commands while an older row is queued/leased/broker_accepted).
If the broker-accepted publish is lost at the device (device reboot before
processing, Wi-Fi glitch, firmware bug), the row and every later command for
that device stay blocked forever. The WEB-01 subscription-readiness fix
(publish only after SUBSCRIBE is registered) removes the *main* loss window,
but a command can still be accepted and lost between the device's SUBACK and
its actual processing.

## 2. Current state (file-level)

| Piece | Location | Behavior |
| --- | --- | --- |
| Deadline storage | `device_commands.delivery_expires_at` (nullable) | NULL = never expires |
| Deadline expiry | `expireDelayedCommands` (`packages/core/src/queue/lease.ts:37-60`) | queued/leased/broker_accepted + past deadline → `delivery_failed` (terminal, releases queue) |
| Enqueue default | `enqueueBatch` options (`enqueue.ts:39-46`) | undefined → NULL deadline |
| API | `packages/api/src/api/app.ts:50` — `delivery_timeout_seconds` optional | omitted → NULL |
| UI | `CommandPanel.tsx:100,119-139` | blank field → omitted |
| Tests | `packages/core/tests/queue/queue.test.ts:412,458` | assert `deliveryExpiresAt` null for blank and non-null when set |
| Firmware | soulcloud_client_demo (separate repo) | executes commands; may take arbitrarily long; no result deadline concept |

## 3. Options

### Option A — finite default deadline (e.g. 60 s, configurable)

- **Mechanism**: `enqueueBatch` defaults `deliveryTimeoutSeconds` to a
  configured value (env `COMMAND_DEFAULT_DELIVERY_TIMEOUT_SECONDS`, default
  60) when the caller omits it. `CommandPanel` pre-fills 60.
- **File changes**: `enqueue.ts` (default), `app.ts` (config plumbing),
  `CommandPanel.tsx` (prefill), `config` (new env), queue tests
  (null-assertion at `queue.test.ts:458` flips), web tests, API tests,
  `docs/en|zh/rest-api.md` (field semantics).
- **Impact**:
  - Long-running commands (firmware tasks that legitimately take minutes)
    would be failed by the platform while the device is still working —
    the device may later report `cmd/result` for a command the platform
    already declared `delivery_failed` (result recording is keyed by
    batch+sequence; a late result would land on a failed row — check
    `recordDeviceResult` behavior before shipping).
  - P95 enqueue→result latency becomes bounded by the default — good
    operational property.
  - Breaking semantic change for existing deployments (commands that
    "eventually complete" would now time out).
- **Rollback**: one-line default flip; data already marked `delivery_failed`
  stays terminal (no automatic revival).
- **Verdict**: simple, but the long-command false-failure is a real product
  risk without a result-deadline escalation path.

### Option B — keep blank (no deadline) + bounded redelivery attempts

- **Mechanism**: keep NULL deadline semantics. Add `attempt_count`-based
  redelivery policy in the *publish* path: when a publish is deferred
  (offline / not-subscribed / publish failure), the broker tracks attempts;
  after N deferred events (e.g. 3) the row moves to `delivery_failed`.
  `leaseNext` already increments `attempt_count` per lease; the deferral
  branches in `packages/broker/src/mqtt/publish.ts` decide.
- **File changes**: `publish.ts` (deferral counting + terminal transition),
  maybe a new state transition helper in `lease.ts`/queue, tests
  (deferral × N → failed), docs.
- **Impact**:
  - Only the *transport* is bounded; a broker_accepted command that the
    device never confirms still blocks the queue forever (same hole as
    today, just narrower).
  - No API/UI semantics change; firmware contract unchanged.
- **Rollback**: remove the counter check; terminal rows stay terminal.
- **Verdict**: fixes the poller-level loop, not the acceptance-level hole.

### Option C — combine: finite default deadline + late-result tolerance

- **Mechanism**: Option A default (60 s) **plus** `recordDeviceResult`
  accepts results for rows already `delivery_failed` (transition
  `delivery_failed` → `completed` when a matching result arrives, honoring
  sequence order), so a long-running command that finishes late still
  resolves correctly instead of producing a false failure.
- **File changes**: A's list + `recordDeviceResult` transition handling +
  tests (late result after expiry), docs.
- **Impact**:
  - Bounded worst case (deadline) with graceful late completion — the
    queue never blocks forever, long commands still record.
  - Slightly larger change surface; the late-result path must respect the
    per-device sequence guard (a late result for an expired command must
    not reorder a newer command's result).
- **Rollback**: per-option revert; late-result acceptance is additive.
- **Verdict**: best operational properties; recommended.

## 4. Recommendation

**Option C**, with a conservative default (60 s is a good starting point;
make it env-configurable). Sequence guard details:

- `recordDeviceResult` already keys on (device, sequence) — verify it is
  idempotent for `delivery_failed` rows and that a late result cannot
  overwrite a *newer* command's outcome (the per-device sequence
  monotonicity makes the check `sequence <= next_command_sequence - 1`).
- Firmware contract: no change required (device already reports results
  with batch+sequence; the platform becomes more tolerant, not stricter).

## 5. Follow-up (product decision needed)

1. Default timeout value (60 s? 5 min?) and whether it should differ per
   command category.
2. Whether `delivery_failed` late results should be surfaced in the UI
   ("completed after timeout" badge) or silently reconciled.
3. Whether the same deadline policy should apply to OTA targets (they
   already have `expires_at`; the question is only about the default).
