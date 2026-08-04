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
