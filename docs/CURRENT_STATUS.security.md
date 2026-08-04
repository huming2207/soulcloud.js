# Security

This document summarizes the threat model, the layered defenses, and the
three external audit rounds (Kimi) whose findings were verified and fixed.

## Layered defenses

### 1. MQTT layer (broker)

- **Identity binding**: clientId MUST equal username (device UID) and pass
  UID validation — no impersonation, no wildcard clientIds
- **Per-device rate limits**: token bucket (20 msg/s sustained, burst 100),
  configurable via `UPLINK_RATE_*`; excess dropped, never buffered
- **Packet size caps**: early reject in `authorizePublish` (256 KB) and the
  dispatch limit (`UPLINK_MAX_PACKET_BYTES`, 64 KB)
- **Auth throttling**: failed authentication waits 100 ms; DB failures
  return CONNACK code 3 (server unavailable)
- **Backpressure**: `ws.send() < 0` (full socket buffer) reports a stream
  error so QoS 1 frames are never silently dropped

### 2. Parsing layer

- MessagePack: nesting capped at 512, duplicate keys rejected, trailing
  bytes rejected, bounded lengths, byte-array-vs-bin distinguished
- on9log: bounded header/payload parsing, dynamic-string length cap
  (64 KB), BOOT opaque, BUFFER chunk bounds, level 0..5 validation
- SLIP (test helper only): all throw paths consume the bad bytes so a
  corrupted stream resyncs
- ELF: pure parsing (never executed), all offsets bounds-checked, only
  recognized sections extracted (no DWARF/strings)

### 3. Rendering layer

- field width ≤ 4096, precision 0..100, total output ≤ 1 MB — malicious
  format strings produce typed errors, never OOM/RangeError

### 4. API layer

- Zod validation for every path/query/body parameter
- uniform 500 `{error:"internal"}` — no internal messages leak
- uploads capped at 32 MB before buffering (declared length + streamed cap
  for chunked)
- command batches capped at 1000 targets

### 5. Authentication & credentials

- argon2id (Bun.password) for human and device passwords; no legacy formats
- JWT access tokens short-lived; refresh tokens server-side, revocable,
  rotation with chain-wide reuse detection
- project membership enforced (403) on all project-scoped operations
- device credential revoke kills live sessions

## Audit history

Three rounds of external review (`REVIEW_RESULT.kimi.md`,
`REVIEW_VERIFY.kimi.md`, and the outcome records in `llm-docs/soulcloud/`)
produced 33+ findings. All were verified (several reproduced with runtime
tests) and fixed. Highlights:

| Round | Key fixes |
| --- | --- |
| 1 (RESULT) | identity impersonation, `{:g}` trailing-zero loss, int4 overflow after 24.8 days uptime, error leakage, upload memory DoS, non-atomic import, recursion depth, negative bigints, precision RangeErrors, BOOT packets, sequence ordering, notify reconnect |
| 2 (VERIFY) | CI branch + missing prisma generate, Content-Length check order, WS backpressure, trimFloat second path, cross-project firmware binding, dead cache wired in, scrypt N validation |
| 3 (Round-3) | chunked upload cap, log hot-path cache, checked-in fixtures (zero silent skips), test isolation (no global DELETEs), slip helper resync |

Every round also added regression tests; the final coverage audit added 8
more tests and fixed a real IDOR (command batches did not check device
project membership).

## Open items (documented, not bugs)

- No authentication on the broker WS endpoint beyond device credentials
  (TLS is the reverse proxy's job; WebSocket origin checks could be added)
- Rate limiting per IP at the proxy level is not implemented (in-broker
  per-device limits are)
- Object storage encryption/retention policies are deferred
- `hashDevicePassword`'s argon2id parameters are Bun.password defaults
  (cost tuning is a deployment decision)
