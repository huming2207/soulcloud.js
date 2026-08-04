# Database

PostgreSQL is the only durable store and the source of truth. The schema is
defined in `packages/core/prisma/schema.prisma` (Prisma 7, generated client in
`packages/core/generated/prisma`, gitignored). Migrations live in
`packages/core/prisma/migrations/`.

## Tables

### Identity & tenancy

| Table | Purpose |
| --- | --- |
| `users` | Human users: unique `username`/`email`, argon2id `password_hash` |
| `organisations` / `projects` | Original multi-tenant scaffolding (unused so far) |
| `organisation_users` / `organisation_projects` | Original M2M scaffolding |
| `user_projects` | **Active tenancy model**: direct user → project membership (G group) |
| `refresh_tokens` | Server-side JWT refresh tokens: SHA-256 only, expiry, revocation, rotation chain |

### Devices & commands

| Table | Purpose |
| --- | --- |
| `devices` | Device registry: global unique `device_uid` (MQTT username/clientId), project-scoped `assigned_id`, argon2id `password_hash`, `auth_revoked` flag, per-device monotonic `next_command_sequence` |
| `command_batches` | One durable row per API batch request |
| `device_commands` | The durable command outbox: per-device row with MessagePack payload, state machine, lease fields, delivery deadline, result fields |

### Logging (on9log)

| Table | Purpose |
| --- | --- |
| `firmware_artifacts` | Uploaded ELF per project; `build_id` = ELF SHA-256 (unique per project); import state |
| `firmware_log_strings` | Artifact + ELF address → tag/format string dictionary |
| `raw_log_events` | Immutable raw on9log packets + envelope metadata (source of truth) |
| `device_firmware_state` | Latest reported firmware hash per device (from `stat.fw`) |

## Key design decisions

- **unsigned 32-bit wire values are `BigInt` columns** (`deviceTimeMs`,
  `tagId`, `fmtId`, `FirmwareLogString.address`): int4 is signed and
  overflows after ~24.8 days of device uptime (audit fix S4).
- **`raw_log_events.id` is autoincrement BigInt** for cursor pagination
  (`WHERE id < cursor`), not UUID.
- **CHECK constraints** that Prisma cannot express are appended to the
  initial migration (state validity, lease/broker/result consistency,
  not-blank, positive counters). The command state machine is enforced in
  SQL:
  ```sql
  CHECK (state IN ('queued','leased','broker_accepted','device_completed','delivery_failed'))
  CHECK (state='leased' AND lease_expires_at IS NOT NULL OR state<>'leased' AND lease_expires_at IS NULL)
  CHECK ((state IN ('broker_accepted','device_completed') AND broker_accepted_at IS NOT NULL) OR ...)
  CHECK ((state='device_completed' AND result_code IS NOT NULL AND result_packet IS NOT NULL AND device_completed_at IS NOT NULL) OR ...)
  ```
- **Query indexes** for the claim path:
  `device_commands_claim_idx (available_at, created_at, id) WHERE state IN ('queued','leased')`,
  `device_commands_device_pending_idx (device_id, created_at, id) WHERE state IN ('queued','leased','broker_accepted')`,
  `device_commands_batch_state_idx (batch_id, state)`.

## Migrations

| Migration | Content |
| --- | --- |
| `initial_domain_schema` | users/organisations/projects/devices/relations + CHECKs |
| `log_ingestion` | firmware_artifacts, firmware_log_strings, raw_log_events, device_firmware_state |
| `int_to_bigint_log_columns` | audit fix S4 |
| `artifact_build_unique_per_project` | audit fix M3 (build identity per project) |
| `command_delivery_timeout` | `delivery_expires_at` + `delivery_failed` state (M2) |
| `auth` | refresh_tokens, user_projects, devices.auth_revoked (G group) |

Migration management: `bun run db:migrate` (dev) / `db:deploy` (CI/prod).
`prisma.config.ts` loads `.env` from the package dir or repo root.

## Integrity notes

- Deleting a project cascades user links and artifacts; deleting a device is
  RESTRICTed while it has commands or log events.
- The `build_id` unique index is per-project (audit fix M3): the same ELF can
  exist in two projects without leaking references across tenants.
