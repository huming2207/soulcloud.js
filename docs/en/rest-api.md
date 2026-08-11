# REST API

The API (`packages/api/src/api/`) is an Elysia server. Body validation is
done manually with Zod inside handlers (Elysia's `onError` hook is
unreliable under Bun and its ValidationError response shape does not match
our `{error, message}` contract). All handlers wrap unexpected failures with
`handleApiError` → uniform `500 {error:"internal"}` — internal messages
never leak.

## Endpoints

### Health

| Endpoint | Behavior |
| --- | --- |
| `GET /health/live` | always `200 {"status":"ok"}` |
| `GET /health/ready` | PostgreSQL ping → `200 ready` / `503 not_ready` |

### Auth (`packages/api/src/api/auth.ts`)

| Endpoint | Behavior |
| --- | --- |
| `POST /v1/auth/register` | `{username, password, email}` → creates user + personal project; `201` with token pair; `409` on taken username/email |
| `POST /v1/auth/login` | `{username, password}` → token pair; `401 invalid_credentials` |
| `POST /v1/auth/refresh` | `{refresh_token}` → rotated token pair; `401` on unknown/expired/reused |
| `POST /v1/auth/logout` | revokes the refresh token |

### Commands (`packages/api/src/api/app.ts`)

| Endpoint | Behavior |
| --- | --- |
| `POST /v1/command-batches` | `{device_ids, command, delivery_timeout_seconds?}` → `202 {batch_id, device_count}`; requires auth; every target device's project must be accessible (403 otherwise) |

Error mapping (Rust-compatible): `400 invalid_targets` (empty/duplicate/too
many, cap 1000), `404 target_devices_not_found`, `422 invalid_device_uid`,
`400 invalid_request`, `500 command_queue_unavailable` (details logged only),
`401 unauthorized`, `403 forbidden`.

### Current user (`packages/api/src/api/me.ts`)

| Endpoint | Behavior |
| --- | --- |
| `GET /v1/me` | current user + project list: `{user_id, username, projects: [{project_id, name, device_count}]}` (registration creates a personal project); `401` without auth |

### Devices (`packages/api/src/api/devices.ts`)

| Endpoint | Behavior |
| --- | --- |
| `GET /v1/projects/:id/devices?limit=&offset=` | offset-paginated device list with per-device firmware state and `total` (devices have no timestamp column, so offset pagination instead of keyset); `404 project_not_found`, `403` non-member |
| `GET /v1/devices/:id` | device detail: uid, assigned_id, project, auth_revoked, next_command_sequence, firmware state; `404`/`403` |
| `POST /v1/devices` | `{project_id, assigned_id, device_uid}` → `201` with one-time `mqtt_password` (argon2id stored, same contract as credentials issue); `422 invalid_device_uid` (unsafe for MQTT topics), `409 device_uid_taken` / `409 assigned_id_taken` |
| `GET /v1/devices/:id/commands?limit=&cursor=` | per-device command history, newest first, keyset on per-device `sequence`; payloads decoded to `{cmd, args}` (bigint → string, bytes → base64), terminal results decoded to `{code, payload}` |
| `GET /v1/command-batches/:id` | batch detail: `summary` per state + per-device decoded commands; a batch may span several of the caller's projects (403 if any target project is inaccessible) |

### Firmware artifacts & logs (`packages/api/src/api/logging.ts`)

| Endpoint | Behavior |
| --- | --- |
| `POST /v1/firmware-artifacts` | multipart `file` + `project_id` (+ optional `version`); SHA-256 build id; synchronous dictionary import; `201` (or `200` idempotent re-upload); `413` over 32 MB (declared length or streamed cap for chunked); `422 invalid_elf`; `409` not used (idempotent instead) |
| `GET /v1/firmware-artifacts?project_id=&limit=` | artifact list with dictionary entry counts |
| `GET /v1/devices/:id/logs?limit=&cursor=&include_raw=` | cursor-paginated raw events, decoded on demand (`tag`, `message`, `decode_state`); `include_raw=1` adds base64 raw packets |
| `GET /v1/devices/:id/firmware-state` | current fw hash / artifact / reported time |
| `POST /v1/devices/:id/firmware-state` | `{artifact_id}` manual bind (artifact must belong to the device's project, 403 otherwise); backfills `unknown_fw` events |
| `POST /v1/devices/:id/credentials` | issue device credentials (password returned once, argon2id hash stored, clears revocation) |
| `POST /v1/devices/:id/credentials/revoke` | refuse new connections AND kill the live session (NOTIFY) |

### Realtime log stream (`packages/api/src/api/log-stream.ts`)

| Endpoint | Auth | Frames |
| --- | --- | --- |
| `GET /v1/ws/logs?device_id=<uuid>` | `Sec-WebSocket-Protocol: ["soulcloud", "<access token>"]` | `{type:"ready"}` on open · `{type:"log", device_id, event}` per event · `{type:"pong"}` heartbeat reply |

| `GET /v1/ws/commands?batch_id=<uuid>` | same | `{type:"ready"}` on open · `{type:"batch", batch_id, device_count, summary, commands}` per state change · `{type:"pong"}` |
| `GET /v1/ws/ota?job_id=<uuid>` | same | `{type:"ready"}` on open · `{type:"ota", job_id, release_id, created_at, state, targets, summary}` per target transition · `{type:"pong"}` |

Command stream: `recordDeviceResult` `pg_notify`s `soulcloud_command_results`
(payload = batch id, inside the recording transaction, delivered
post-commit; QoS1 replays and mismatches never notify). The pushed
`{type:"batch"}` frame is identical to `GET /v1/command-batches/:id`.

OTA stream: LISTENs `soulcloud_ota` (payload = job id) and pushes the
same shape as `GET /v1/ota-jobs/:id` plus a derived job-level
`state` (`running` / `completed` / `failed`).

WebSocket upgrade that streams decoded log events for one device. Because
browsers cannot set headers on a WebSocket, the access token rides the
subprotocol list; the upgrade is rejected with `401` unless the token is
valid, `400` on a non-UUID `device_id`, and `404` when the device does
not exist or the caller is not a project member (`authenticateRequest`
is reused by projecting the subprotocol token onto an Authorization
header).

Data path: `ingestLogPacket` / `ingestLogBundle` `pg_notify` the
`soulcloud_log_events` channel (payload = the device id only; the hub
re-queries everything above its per-device high-water mark, so event
ids never travel in the notify — lossy by design, consumers fall back
to REST paging); the API process runs a process-wide lazy LISTEN hub
(reconnects on failure) that looks up subscribers **before** touching
the database (a notify with no subscribers never runs a query) and
decodes server-side via `decodeEventsBatch` (dictionary cached per
artifact, 60 s TTL, bounded eviction), then fans each event out to
every subscriber of the device.

Stream hardening (shared with the command/OTA streams):

- **Debounce**: burst notifies for the same device are merged into one
  re-query + one push (250 ms window, plus a max-wait bound so a
  sustained burst cannot starve the push).
- **Token expiry**: the handshake token's `exp` is enforced on the live
  connection — the server closes with `4401 token expired` once it
  passes; the frontend hook reconnects with a fresh token.
- **Connection cap**: per-process limit (default 500) refuses extra
  sockets with `4401 too many connections`.
- Subscriber keys are normalized (lower-case UUIDs) so a mixed-case
  `device_id` query still receives pushes.

`event` has the same shape as `GET /v1/devices/:id/logs` items (`id`,
`received_at`, `device_time_ms`, `sequence`, `packet_type`, `level`,
`tag`, `message`, `decode_state`; no `raw_packet_b64`). Clients may send
`"ping"` or `{"type":"ping"}` as a heartbeat.

```json
{"type":"ready","device_id":"<uuid>"}
{"type":"log","device_id":"<uuid>","event":{"id":"42","received_at":"2026-08-07T11:00:00Z","device_time_ms":"1700000000123","sequence":7,"packet_type":1,"level":2,"tag":"app","message":"booted","decode_state":"decoded"}}
{"type":"pong"}
```

### Firmware releases & OTA jobs (`packages/api/src/api/firmware.ts`)

| Endpoint | Behavior |
| --- | --- |
| `POST /v1/firmware-releases` | multipart `bin` (required) + `elf` (optional) + `project_id` (+ optional `version`); `201`/`200` idempotent; `413`/`422` |
| `GET /v1/firmware-releases?project_id=&limit=&cursor=` | cursor-paginated release list (`<createdAt>|<releaseId>` composite keyset) |
| `GET /v1/firmware-releases/:id` | detail incl. linked artifact build id + dictionary entries |
| `POST /v1/firmware-releases/:id/deploy` | `{device_ids}` → `201 {job_id, targets}`; fan-out of per-device download credentials over MQTT |
| `GET /v1/firmware-releases/:id/bin` | binary download (Bearer for humans, per-device short JWT for devices, legacy `?token=` kept) |
| `GET /v1/ota-jobs/:id` | job detail with per-target states and current firmware |
| `GET /v1/ota-jobs?project_id=&limit=&offset=` | job list with `target_count` and per-state `summary` (aggregated via groupBy) |

### Rollouts (`packages/api/src/api/rollout.ts`)

| Endpoint | Behavior |
| --- | --- |
| `POST /v1/firmware-releases/:id/rollouts` | create a phased deployment: `strategy: auto` (server-randomized pool + ratios, default 5/25/100%) or `grouped` (client groups); per-rollout settings `success_ratio` (0.9), `min_sample` (10), `phase_timeout_hours` (24), `stuck_hours` (6), `manual_approval`; optional `from_release_id` for rollback |
| `GET /v1/ota-rollouts/:id` | detail: state, settings, per-phase job summaries, pool size |
| `GET /v1/ota-rollouts?project_id=&limit=&offset=` | rollout list with `pool_size`, strategy/state and cross-phase `progress` per state |
| `POST /v1/ota-rollouts/:id/pause` | stop advancing (in-flight deliveries untouched); `409` wrong state |
| `POST /v1/ota-rollouts/:id/resume` | resume a paused rollout or a manual-approval wait (activates the next phase) |
| `POST /v1/ota-rollouts/:id/abort` | stop advancing; delivered devices keep their firmware; pending phases cancelled |
| `POST /v1/ota-rollouts/:id/rollback` | abort + create a `from_release_id` ota_job for the rollout's `completed` devices (installed excluded); idempotent; `409 rollback_unavailable` without a baseline or confirmed devices |

Advance loop: the API process polls every `ROLLOUT_POLL_INTERVAL_MS`
(30s); conditional UPDATEs make multiple API instances safe. Gating:
`completed/actual ≥ success_ratio` and `completed ≥ min(min_sample,
actual)`; phase timeout without meeting → auto-pause (never auto-rollback);
stall judgement: `installed` > stuck_hours AND device alive (stat within
1h) AND fw mismatch → `failed (-6)` (powered-off devices are spared).

## Validation

`packages/api/src/api/validate.ts` centralizes:

- `UuidParam` — path/query UUIDs
- `CursorParam` — positive integer cursor (log pagination)
- `LimitParam` — integer 1..500 page size
- `authenticateRequest()` — Bearer JWT → user (or null)
- `userCanAccessProject()` — user_projects membership
- `handleApiError()` — uniform 500 without leaking internals

## Pagination

Log queries use keyset pagination on `raw_log_events.id` (auto-increment):
`?cursor=<last_id>` returns older events; `next_cursor` is present when more
rows exist. Page size defaults to 100, capped at 500.

## Notes

- Multipart uploads reject oversized bodies before buffering (declared
  `Content-Length`, plus a streamed hard cap for chunked requests).
- `include_raw` is opt-in to keep default responses small.
- Undecodable log events return `message: null` with their `decode_state`;
  raw data is always retained.
