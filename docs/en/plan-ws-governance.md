# SoulcloudJS WebSocket Scalability Design

> English translation of the Chinese original; the authoritative Chinese
> version is docs/zh/plan-ws-governance.md.

**Date**: 2026-08-12 · **Status**: design (not implemented) · **Basis**: GPT/Codex
review REPORT_RESULT.gpt.md, WEB-05/WEB-07 and the command-deadline suggestions
(items excluded from the current implementation round)
**Repo**: soulcloudjs (this design is read-only; no code changes)

## 0. Background and current facts

Review findings (verified):
- 5 independent WS hubs (log/command/ota/status/notifications) each keep their
  own connection counter, default 500 each (`app.ts:154-158` passes the same
  `streamOptions.maxConnections`, but each hub has its own internal
  `connectionCount`) → the effective process limit is ~2500, not 500
- Every socket owns two intervals: the M2 token-expiry check
  (`expiryByWs`/`expiryTimers`) and the membership re-check
  (`scheduleMembershipCheck`, `ws-access.ts:32-75`, one serial `findUnique`
  per project, no re-entry guard)
- Command/OTA pushes re-read and serialize the whole batch/job on every
  debounced update (`command-stream.ts:187-221`, `ota-stream.ts:202-283`) —
  a 1000-target job means O(N) DB + JSON + network per push
- The OTA poller still leases one row at a time (`ota-publish.ts:62-112`
  `otaPollOnce` leases a single target); **the command side was changed to a
  bounded drain in this round** (`publish.ts` `DEFAULT_DRAIN_MAX_PER_CYCLE=100`)
- Commands have no default deadline (`enqueue.ts:39-46` NULL = never expires);
  `CommandPanel.tsx:100,119-139` defaults to blank

---

## Topic A: Global WS connection budget

### Current state
Each hub has its own `connectionCount` with its own limit (default 500). The
`SOULCLOUD_WS_MAX_CONNECTIONS` env var is read independently by all 5 hubs, so
the effective process limit is 5 × value. One user can open 500 connections on
each of the 5 streams.

### Options

**A1. Shared counting module (recommended)**
New file `packages/api/src/api/ws-budget.ts`:

```ts
// ws-budget.ts — process-wide atomic budget (Bun is single-threaded, lock-free)
export interface WsBudget {
  /** Try to take one quota slot; returns false when exhausted (caller closes 4401). */
  tryAcquire(): boolean;
  /** Release a quota slot (idempotent). */
  release(): void;
  /** Current usage (for metrics). */
  readonly current: number;
}

export function createWsBudget(limit: number): WsBudget {
  let current = 0;
  return {
    tryAcquire() {
      if (current >= limit) return false;
      current += 1;
      return true;
    },
    release() {
      current = Math.max(0, current - 1);
    },
    get current() {
      return current;
    },
  };
}
```

- `app.ts` creates **one** `createWsBudget(SOULCLOUD_WS_MAX_CONNECTIONS ?? 2000)`
  and passes it through each hub factory's options (new `budget?: WsBudget` field)
- In each hub's `subscribe`: `if (!budget.tryAcquire()) { ws.close(4401, "too many connections"); return; }`,
  and `budget.release()` in `unsubscribe`; the hub's own `connectionCount` is
  removed (or kept as a per-hub metric only)
- Compatibility: the `maxConnections` option stays but its semantics become an
  **additional per-hub cap** (global budget first, then hub cap); without it,
  only the global limit applies
- Tests: inject a small budget (e.g. 3), allocate 4 connections across hubs →
  the 4th is rejected with 4401; after release, connection succeeds again

**A2. Simple shared counter (minimal intrusion)**
No module: move the 5 hubs' counters into one closure variable in app.ts and
pass it down. Drawbacks: no encapsulation; hub singletons
(`getXxxStreamHub` process-level singletons) make test-state reset hard. A1 is
better.

**A3. Per-user/IP limits (P2)**
A keyed map on top of the budget (userId/IP → count, TTL cleanup). Not this
round — it needs the global budget first.

### Recommendation: A1
- Effort: S (new module ~40 lines + 3 lines per hub × 5 + tests ~30 lines)
- Risk: low. Only note: hubs are process-level singletons, so the budget must
  be created once in app.ts and injected — **never default-created inside a hub
  factory** (test isolation); tests inject it explicitly
- Metrics: expose `budget.current` in `/v1/health` or log fields

---

## Topic B: Centralized expiry scheduler

### Current state
Two intervals per socket:
1. M2 token expiry (`command-stream.ts:284-300` etc., duplicated in every
   stream): `setInterval` every `expCheckIntervalMs` (default 30s) checks the
   `expiryByWs` deadlines
2. Membership (`ws-access.ts`): `scheduleMembershipCheck` queries per project
   every intervalMs

1000 connections × 2 = 2000 intervals. Node/Bun handles thousands of intervals
without strain (timers are a binary heap), but every interval firing costs one
callback + one Map lookup; and each stream carries its own copy of the expiry
implementation (copy-pasted 4 times).

### Options

**B1. Central scheduler (recommended)**
New file `packages/api/src/api/ws-scheduler.ts`:

```ts
// ws-scheduler.ts — process-level single scheduler: one interval scans due items
export interface SchedulerHandle {
  /** Register a due action; returns a cancel function. */
  schedule(deadline: number, action: () => void): () => void;
}

export function createScheduler(tickMs = 5_000): {
  schedule: SchedulerHandle["schedule"];
  /** Number of registered items (for metrics). */
  size: number;
  /** Shut the scheduler down (process exit / tests). */
  close: () => void;
}
```

Implementation: internal `Map<deadline, Set<action>>` or a min-heap; a single
`setInterval(tickMs)` scans due items, runs them and deletes them; `schedule`
is idempotent (re-scheduling the same action cancels the old entry first).
Timer count drops from 2N to 1.

- M2 expiry: `expiryByWs` becomes `schedule(expMs, () => ws.close(4401, "token expired"))`
  per socket (the close handler cleans up the registration)
- Membership: `scheduleMembershipCheck` registers "run one check at
  now+intervalMs; if the socket is still OPEN, schedule again" (chained
  self-renewal, naturally re-entry-safe — the next check is only scheduled
  after the previous one finished)
- The per-stream expiry copy-paste converges into the scheduler

**B2. Keep the status quo + docs**
2000 intervals will not crash Bun (binary heap, O(log n)), but each socket
costs two callbacks per 30s and one Map access per callback — 1000 connections
≈ 66 callbacks/s, negligible. The real cost is **code duplication** (4 expiry
implementations) and the **inability to measure uniformly**.

### Recommendation: B1 (motivation is converging duplication + re-entry safety, not CPU)
- Effort: M (scheduler ~80 lines + ws-access changes + replacing per-stream
  expiry + tests)
- Risk: medium-low. Notes: scheduler singleton lifecycle (close on process
  exit); `scheduleMembershipCheck`'s chained self-renewal must stop scheduling
  after socket close (keep the existing `readyState !== 1` guard)
- Test strategy: inject a short tick (e.g. 10ms) + setSystemTime advance,
  assert due-firing/cancel/re-entry-safety

---

## Topic C: Membership check batching

### Current state
`ws-access.ts:58-75`: every interval runs **serial `findUnique` per project**
over `projectIds`. A connection with 3 projects = 3 queries per 30s. 1000
connections × ~2 projects ≈ 2000 queries per 30s (~67/s) — acceptable but
wasteful; and there is no re-entry guard — the interval callback is async, so a
slow query (> interval) overlaps with the next tick (DB pool pressure stacks).

### Options

**C1. Batched query + re-entry guard (recommended)**
- Query shape: fetch the user's whole membership once, compare in memory:

```ts
// one query instead of N
const links = await prisma.userProject.findMany({
  where: { userId },
  select: { projectId: true },
});
const owned = new Set(links.map((l) => l.projectId));
for (const pid of projectIds) {
  if (!owned.has(pid)) { /* close 4403 */ }
}
```

Note: does `userProject` have a userId index? The schema has a composite unique
`userId_projectId` (`where: { userId_projectId }`) — `findMany({ where: { userId } })`
needs a userId-prefix index; the composite unique's **first column is userId**,
so it is usable. Confirm in schema; add a migration if there is no single-column
index (P2). Project count = the user's visible project count (small, usually
< 10), in-memory comparison cost is negligible.

- Re-entry guard: `scheduleMembershipCheck` gets an `inFlight` flag — set at
  callback start, cleared at end; skip this round while `inFlight` (or B1's
  chained self-renewal makes this disappear naturally — preferred once B1 lands)

**C2. Keep the status quo**
67/s queries are fine at small scale, but overlapping execution is a real
defect (slow queries stack).

### Recommendation: C1 (implement together with B1)
- Effort: S (ws-access changes ~20 lines + tests)
- Risk: low. Behavior change: per-project queries become one batched query;
  results are semantically equivalent; DB pressure drops from O(projects) to O(1)
- Tests: user with 2/3 project memberships → close/survive assertions; slow
  query (mock prisma hangs) → no overlapping execution

---

## Topic D: command/ota stream delta updates

### Current state
`pushJobUpdate` (ota-stream.ts:202-283): every debounced push **re-reads the
whole job + targets** (with device nesting + firmwareState subqueries) + full
JSON serialization + send to every subscriber. With 1000 targets:
- DB: one query for ~1000 rows (with nesting) — not expensive (PK lookup)
- JSON: ~200 bytes per target → ~200KB per push; debounce merges per 250ms, so
  high-frequency changes (e.g. 1000 targets confirming one by one) push 200KB ×
  subscribers every 250ms
- Network: 200KB × N subscribers × per 250ms — significant bandwidth and
  serialization cost for large jobs

The command stream is the same (`loadCommandBatchDetail` loads the full batch).

### Options

**D1. Incremental pushes (version + change events)**
- Server: the hub keeps `jobId -> { version: number, lastSentSnapshot?: string }`;
  each push re-reads the full state (DB query unchanged), but **diffs against
  the last sent snapshot**: push only `{ type: "ota_delta", job_id, version, changed: [...changed target rows], summary }`;
  no changes = no push (after debounce still no change = skip)
- Simplified: **push only changed targets** — the hub records a signature per
  target from the last push (`targetId -> state+resultCode+confirmedAt`) and
  serializes only rows whose signature changed. 1 change among 1000 targets →
  ~300-byte push
- Client (OtaJobPage): merge the delta into the cache before `setQueryData`
  (in the `update` function, merge the `changed` array by device_id).
  **Compatibility**: current consumers replace the whole cache with the full
  detail; delta needs merge logic — one place changes on the frontend
  (OtaJobPage/CommandPanel onMessage handling)
- Full snapshots are still needed: on **first connect** (or reconnect after
  drop) a full push is required — the hub pushes the full snapshot at
  subscribe time, then only deltas

**D2. Paginated snapshots**
Keep full state but paginate client-side: push only summary + version; the
client fetches detail pages via REST on demand. Pros: minimal server push;
cons: real-time behavior depends on client polling/on-demand fetch, semantics
differ from the current "push-to-refresh", larger frontend change.

**D3. Keep the status quo + docs**
200KB × high-frequency push only hurts with >500-target jobs. 1000 targets
full push per 250ms = 4/s × 200KB = 800KB/s per subscriber — acceptable for
one subscriber; 10 operator terminals = 8MB/s, not acceptable.

### Recommendation: D1 (diff deltas, push changed targets + summary first; full only on first connect)
- Effort: M (hub signature diff ~60 lines + frontend merge ~30 lines + tests)
- Risk: medium. Notes:
  - **Loss/reconnect**: after WS drop and reconnect a full push is mandatory
    (full push at subscribe — existing semantics preserved)
  - **Versioning**: `version` monotonic (job updatedAt or a hub counter); the
    client may detect out-of-order (optional)
  - **Debounce × diff interaction**: diff computed at push time (snapshot read
    vs last-sent snapshot) — naturally correct
  - Frontend `setQueryData` merge must be **idempotent** (repeated deltas must
    not double-count)
- Tests: 1000-target simulation (seeded) → single target change → payload size
  assertion (< 5KB); reconnect full-push assertion
- **Metrics**: payload bytes per push, diff hit rate

---

## Topic E: OTA drain + command deadline

### E1. OTA poller bounded drain

**Current state**: `otaPollOnce` (ota-publish.ts:62-112) single-row lease:
expire → lease 1 target → publish/defer → done. Default 500ms interval → 1000
targets ≈ 500 seconds (all online, all subscribed); near the default OTA
delivery window (OTA_TARGET_TTL_SECONDS=900s) edge.

**Reference**: the command side is already drained (`publish.ts`
`DEFAULT_DRAIN_MAX_PER_CYCLE=100`, implemented this round) — OTA copies the
same skeleton.

**Design**:
```ts
// ota-publish.ts: otaPollOnce becomes a loop
export async function otaPollOnce(aedes, prisma, options, log): Promise<void> {
  await expireOtaTargets(prisma);
  const stalled = await expireStalledOtaTargets(prisma, options.stallTimeoutMinutes);
  if (stalled > 0) log.info("ota targets failed by stall timeout", { count: stalled });

  const drainMax = options.drainMaxPerCycle ?? DEFAULT_OTA_DRAIN_MAX_PER_CYCLE; // suggested 50
  for (let i = 0; i < drainMax; i++) {
    const target = await leaseNextOtaTarget(prisma, options.leaseDurationMs);
    if (!target) break; // queue empty
    // original single-target handling body (offline defer / subscription-ready
    // defer / publish / failure release)
    // errors inside one target's handling must not abort the loop
    // (try/catch around it; release the bad target and continue)
  }
}
```
- Differences from the command side:
  - OTA has `expireOtaTargets`/`expireStalledOtaTargets` pre-steps (once per
    round is enough — keep them outside the loop)
  - OTA's defer paths (offline/not-subscribed) use different retry delays
    (5000ms/1000ms) — after defer, **the target is not retried in the same
    round** (released, re-leaseable, but the next round picks it up) — the
    drain loop cannot spin: the lease semantics guarantee `availableAt` is in
    the future after release, so `leaseNextOtaTarget` will not immediately
    re-lease it
  - Budget 50 per round (more conservative than commands' 100 — each OTA
    target involves token signing + publish, slightly heavier)
- **File-history constraint**: ota-publish.ts was historically maintained by
  another agent (verify with `git log --oneline -- packages/broker/src/mqtt/ota-publish.ts`;
  recent commits in this repo are all from this session, but the file touches
  firmware-protocol semantics: OTA notice payload, token signing) — change
  **only the polling skeleton** (poll loop/budget constant), **not** the notice
  payload, token, or timeout semantics
- Tests: seed 1000 targets → short interval + budget → assert completion
  count/time; a single target's defer does not block others (offline + online
  mix → online delivered first)

**E1 recommendation**: do it. Effort M, risk medium-low (skeleton change,
semantics unchanged).

### E2. Command default deadline (product decision)

**Current state**: `enqueue.ts` `deliveryTimeoutSeconds` NULL = never expires;
`CommandPanel` defaults to blank. After a delivery loss (now mitigated by the
subscription-ready check), a command without a deadline permanently occupies
the device queue head (`lease.ts:74-89` blocks per-device FIFO).

**Options**:

**E2-A. Keep blank (status quo)**
- Pros: simple command semantics ("send until the device answers"); long
  commands (firmware runs for minutes) are not constrained
- Cons: on delivery-level failures (gaps in the subscription check, broker
  internal loss) the device queue blocks forever; operators have no visibility

**E2-B. Finite default deadline (e.g. 60s, configurable override)**
- API: `enqueueBatch`'s `deliveryTimeoutSeconds` defaults to
  `DEFAULT_DELIVERY_TIMEOUT_SECONDS` (env-configurable, default 60)
- Frontend: CommandPanel timeout input prefilled with 60 (user can clear →
  default; or an explicit "no limit" option)
- Impact: firmware commands running > 60s become `delivery_failed` — **breaks
  long-running tasks**. Mitigation: is the deadline a "delivery window" rather
  than an "execution limit"? Current implementation: `availableAt +
  deliveryTimeoutSeconds` → expired = `delivery_failed` (lease.ts:46) — it is
  the **total window** (including execution). Long tasks must pass a large
  value explicitly
- Contract change: existing tests (that don't pass a timeout) all pass through
  the 60s default — no test impact (fast path); real user behavior changes
  (implicit behavior change)

**E2-C. Automatic redelivery cap (dead-letter)**
- Keep blank semantics, but if a device shows no result long after
  `broker_accepted` (e.g. > 10 minutes) → automatic requeue retry (idempotent:
  the device dedupes by command_id — **the firmware currently has no
  idempotency contract**, redelivery may re-run commands with side effects)
- Requires a firmware contract first (soulcloud_client_demo is a separate repo
  — contract change needs firmware cooperation)
- Pros: does not break long tasks; cons: depends on firmware idempotency,
  otherwise dangerous

**E2-D. Recommended combination**:
1. **Short term (no firmware changes)**: keep blank default, but **add
   observability** — broker warns (log; optional webhook) when a queue-head
   command has been waiting > threshold (e.g. 5 minutes); CommandPanel shows
   "oldest command in this device's queue has waited X" (prevents silent stalls)
2. **Medium term (needs firmware idempotency contract)**: E2-C's redelivery
   cap + command_id idempotency (protocol docs updated, firmware follows)
3. **Product decision (user's call)**: add a "soft cap" to blank semantics
   (e.g. `delivery_failed` after a default 24h) — balances long tasks against
   permanent blocking

**E2 recommendation**: do not change the default semantics (E2-B breaks long
tasks); implement E2-D. **Decision points for the user**:
- D1: should blank get a soft cap (24h)?
- D2: start the firmware idempotency contract work (cross-repo)?

---

## Suggested SLO table (the measurement baseline the GPT report asked for)

| Metric | Suggested initial target | Basis/notes |
| --- | --- | --- |
| Supported online devices | 500 (single broker process) | aedes single process + current polling throughput; needs E1 drain + multi-instance (WEB-06) to go beyond |
| Peak logs/device/s | 20/s sustained / 100/s burst 10s | rate-limit default 20/s (UPLINK_RATE_PER_SECOND); bundles up to 128 elements per publish after merge |
| Command p95 enqueue→device | < 5s (online device, empty queue) | current drain 100/cycle + 500ms interval → ideal ~1s; 5s target leaves headroom |
| OTA targets/minute | 600 (online, all subscribed) | after E1: 50/cycle × 120 cycles/min (500ms); today single-row = 120/min |
| WS connections/process | 2000 global (shared by 5 streams) | Topic A global-budget default; per-stream burst 500 |
| Initial JS gzip | ≤ 220KB gzip (currently 263KB) | target after WEB-10 vendor splitting; LCP < 2.5s (mid-range phone + 4G) |
| WS push bandwidth | ≤ 1MB/s/process (1000-target job full-push scenario) | after Topic D: single-target change pushes < 5KB |

---

## Phased implementation order

| Phase | Content | Dependencies | Risk |
| --- | --- | --- | --- |
| Phase 1 (low risk) | Topic A global budget + Topic C batched queries (re-entry guard can start as an inFlight flag) | none | low |
| Phase 2 (medium) | Topic B central scheduler (converge the 4 expiry copies + membership chained self-renewal) | Phase 1's budget injection pattern | medium-low |
| Phase 3 (medium) | Topic D delta pushes (server diff + frontend merge) | none | medium (frontend compatibility) |
| Phase 4 (medium-low) | Topic E1 OTA drain (copy the command-side skeleton) | none | medium-low (file-history constraint: git log first) |
| Phase 5 (decision) | Topic E2 command deadline combination (observability first) | user decides D1/D2 | low |

## Explicitly out of scope
- Per-user/IP connection limits (A3) — phase 2 once the global budget lands
- Multi-broker session affinity (WEB-06) — architectural, separate initiative
- Push compression (gzip over WS) — Bun WS has no built-in support; cost >
  benefit (small payloads)
