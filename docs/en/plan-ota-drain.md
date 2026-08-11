# OTA Poller Bounded Drain — Design

**Date**: 2026-08-11 · **Status**: proposal (nothing implemented) · **Origin**:
GPT/Codex review WEB-05 (OTA side)

## 1. Problem

The OTA poller delivers **one target per poll cycle**
(`packages/broker/src/mqtt/ota-publish.ts` — `otaPollOnce` leases a single
target via `leaseNextOtaTarget`). With the default 500 ms interval
(`OTA_POLL_INTERVAL_MS`, `packages/broker/src/config.ts:23`), a 1,000-target
job needs ~500 s in the ideal all-online case — right at the edge of the
default delivery window (`DEFAULT_ROLLOUT_TARGET_TTL_SECONDS = 15 * 60`,
`packages/core/src/ota/rollout.ts:40`). Offline deferrals, DB latency, or
competing jobs push later targets past `expires_at`, where they die as
`expired` without ever being published.

The command poller already received this fix (bounded drain,
`packages/broker/src/mqtt/publish.ts` — `DEFAULT_DRAIN_MAX_PER_CYCLE = 100`,
loop in `pollOnce`); the OTA side has not.

## 2. Current state vs the command poller

| Aspect | Command poller (done) | OTA poller (this plan) |
| --- | --- | --- |
| Lease per cycle | 1 → drain up to 100 | 1 |
| Subscription readiness | checked (defer 1 s) | checked (defer 1 s, `4a81b1b`) |
| Offline deferral | `available_at` backoff | `releaseOtaTarget(…, offlineRetryMs)` |
| Expiry pass | `expireDelayedCommands` per cycle | `expireOtaTargets` + `expireStalledOtaTargets` per cycle |
| Wake | lossy `wake()` → one cycle | same |
| Retained publishes | configurable | never (deliberate) |

OTA-specific semantics that must survive a drain loop:

- **Per-target window**: `ota_targets.expires_at` bounds each target;
  leasing does not extend it. A drain loop must not starve later targets
  in the same cycle (bounded budget + interleave order by `created_at` is
  already the lease query's order — fine).
- **Stall semantics**: `expireStalledOtaTargets` fails *delivered* targets
  after `stallTimeoutMinutes`; drain speed does not interact with it.
- **Deferral without busy-loop**: offline/not-subscribed defers set
  `available_at` in the future, so a drain loop naturally stops when every
  remaining target is deferred.
- **Lease duration vs drain duration**: a long drain cycle (100 targets ×
  DB+publish latency) keeps rows leased for the cycle's duration; lease
  duration must comfortably exceed the worst-case cycle (already true at
  default 30 s lease vs ms-scale publishes — confirm in tests).

## 3. Proposed design

Mirror the command poller exactly (same skeleton, different lease call):

```
otaPollOnce:
  expireOtaTargets
  expireStalledOtaTargets
  budget = OTA_DRAIN_MAX_PER_CYCLE (default 100, configurable)
  for i in 0..budget:
    target = leaseNextOtaTarget          // null -> return
    if !online: defer (backoff); continue
    if !subscribed: defer (1 s); continue
    publish notice; markOtaTargetDelivered
```

- **New config**: `OTA_DRAIN_MAX_PER_CYCLE` (default 100) alongside
  `OTA_POLL_INTERVAL_MS` in `packages/broker/src/config.ts`.
- **File changes**:
  - `packages/broker/src/mqtt/ota-publish.ts`: wrap the single-target body
    in the budgeted loop (extract the per-target body into
    `handleLeasedOtaTarget(aedes, prisma, options, log, target)` — the
    current `otaPollOnce` body after the lease becomes that function).
  - `packages/broker/src/config.ts`: new env + default.
  - `packages/broker/src/index.ts`: pass `drainMaxPerCycle` through.
  - Tests (below).
- **Non-goals**: no concurrency (parallel publishes) in v1 — the loop is
  sequential like the command poller; parallelism is a later knob
  (`OTA_DRAIN_CONCURRENCY`) if profiling demands it.

## 4. Test plan

- Unit (mock prisma): a cycle publishes up to `budget` targets; stops when
  `leaseNextOtaTarget` returns null; deferrals (offline / not-subscribed)
  consume budget slots but don't error.
- Integration (real broker + DB, existing `ota-publish` test helpers):
  enqueue a job with N targets (e.g. 150 > budget 100) with all devices
  online+subscribed → all N delivered within one wake cycle (assert
  `delivered_at` set before the next poll tick).
- Window test: N=1000 simulation with short `expires_at` (e.g. 10 s) and
  `OTA_DRAIN_MAX_PER_CYCLE=1000` → all delivered inside the window; with
  the old single-target loop the same test would fail (delivery rate 2/s).
- Regression: single target still delivered; stall expiry still fails
  delivered-but-unconfirmed targets; offline deferral backoff unchanged.

## 5. Risks & coordination

- **Recent authorship**: `ota-publish.ts` was last touched by another
  author in `4a81b1b` (2026-08-08, subscription-readiness fix). The drain
  change is additive around that logic — do not rewrite the readiness
  check; extract it verbatim into the per-target handler. Coordinate if
  that author has unmerged work (check `git status`/branches before
  starting).
- **Dead code**: `otaPollOnce` currently computes `topic` twice (duplicate
  try/catch blocks). The refactor removes the duplication — note it in the
  commit message.
- **Lease-duration ceiling**: with a 100-target budget and worst-case
  per-target latency, a cycle could exceed the default lease duration.
  Measure in the integration test; if needed, raise the default lease or
  make the budget adaptive (stop when `now() - cycleStart > leaseMs/2`).

## 6. Recommendation

**Implement the bounded drain exactly as described** (sequential, budget
100, configurable). Expected effect: 1,000-target jobs deliver in ~5-10 s
instead of ~500 s, well inside the 900 s window, and wake() makes fresh
jobs start draining immediately. Concurrency and adaptive budgeting are
follow-ups only if load tests show the sequential loop is the bottleneck.
