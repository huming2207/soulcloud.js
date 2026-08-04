# Command Queue

The durable, per-device command queue is the core of the platform: API
enqueues, the broker delivers over MQTT QoS 1, results are recorded
idempotently. Implementation lives in `packages/core/src/queue/`.

## State machine

```
queued ──lease──▶ leased ──aedes.publish()──▶ broker_accepted ──cmd/result──▶ device_completed
   ▲                 │                              │
   │                 └──(publish failed)────────────┘  (releaseLease)
   │                                                    │
   └──────────────(lease expired)───────────────────────┘
   │
   └──(delivery deadline passed)──▶ delivery_failed   (terminal)
```

- `queued` — inserted by the API, available for leasing
- `leased` — claimed by a broker (lease expiry allows crash recovery)
- `broker_accepted` — the broker accepted the QoS 1 publish (NOT the device)
- `device_completed` — a validated, matching `cmd/result` was stored
- `delivery_failed` — terminal; the per-device queue is released without a
  device result (per-command timeout, audit fix M2)

**Per-device ordering**: only the oldest unfinished command of a device can
be leased; `broker_accepted` still blocks later commands until
`device_completed` (the contract). Ordering compares `sequence` (monotonic
per device), not `created_at` — concurrent enqueues commit in transaction
order, which can differ from start order (audit fix M8).

## Files

| File | Responsibility |
| --- | --- |
| `enqueue.ts` | `enqueueBatch()`: validates targets (non-empty, unique, ≤ 1000, topic-safe UIDs), increments `next_command_sequence` in a transaction, encodes the per-device MessagePack execution packet, inserts batch + rows, `pg_notify`s the wake-up channel. Optional `deliveryTimeoutSeconds` sets `delivery_expires_at`. |
| `lease.ts` | `leaseNext()`: `FOR UPDATE SKIP LOCKED` claim of the oldest eligible row; `expireDelayedCommands()`: moves past-deadline rows to `delivery_failed`. |
| `acknowledge.ts` | `markBrokerAccepted()` (idempotent), `releaseLease()` (publish failure → back to queued). |
| `result.ts` | `recordDeviceResult()`: transaction — lock row, verify id/seq/device UID, idempotent replay of identical results, reject conflicting ones, complete the row. |
| `notify.ts` | Channel constants for LISTEN/NOTIFY. |
| `errors.ts` | Typed `CommandQueueError` with a `kind` discriminator. |

## Delivery semantics

- **QoS 1 + lease recovery allow redelivery**; the server accepts a repeated
  identical result idempotently (`already_recorded`) and rejects mismatched
  or conflicting results.
- **Exactly-once side effects are the device's job**: the firmware must
  durably remember processed sequences and replay stored results (see the
  device-side config storage requirements doc). The server only guarantees
  at-least-once delivery.
- **Per-command delivery deadline** (`delivery_timeout_seconds` in the API):
  NULL = never expires (retried until the device completes it); a value
  means the command moves to `delivery_failed` when the deadline passes,
  releasing the per-device queue.
- **Offline devices**: the poller does not publish to offline devices
  (QoS 1 clean-session messages would be broker-dropped, stranding the
  command); the command stays queued and is delivered on reconnect.

## Wake-up

The API `pg_notify`s `soulcloud_commands` inside the enqueue transaction
(PostgreSQL delivers after commit, so only successful enqueues wake
brokers). The broker's notifier triggers an immediate poll; the 500 ms
interval remains the correctness fallback.

## Result idempotency details

`recordDeviceResult` compares the decoded stored result semantically
(binary IDs byte-wise, numbers/bigints normalized, NaN equal to itself);
a result arriving before the local PUBACK handling completes the row
directly from `queued`/`leased` (the result itself proves broker
acceptance).

## Tests

`packages/core/tests/queue/queue.test.ts` (20 tests): atomic enqueue,
sequence allocation, empty/duplicate/missing/unsafe targets, lease claims,
expiry recovery, per-device ordering (broker_accepted blocks),
markBrokerAccepted/releaseLease conflicts, result idempotency/conflict/
mismatch, delivery deadlines, concurrent-enqueue ordering.
