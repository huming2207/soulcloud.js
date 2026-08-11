# Authentication

Two distinct authentication models, by design:

- **Humans** (REST API): JWT dual-token — short-lived stateless access token
  + long-lived server-side refresh token
- **Devices** (MQTT): per-session stateful authentication — never JWT

## Human users: JWT dual-token

Implementation: `packages/core/src/auth/tokens.ts`, routes in
`packages/api/src/api/auth.ts`.

### Flow

```
register/login ──▶ {access_token, refresh_token}
                       │
   access_token (HS256 JWT, default 15 min, stateless)
       │  used for every protected API call: Authorization: Bearer ...
       ▼
   expires ──▶ POST /v1/auth/refresh {refresh_token}
                   │  verifies server-side record
                   │  revokes the old token
                   ▼
         {new access_token, new refresh_token}   (rotation)
```

### Refresh token design

- 256-bit random value; **only its SHA-256 is stored** in `refresh_tokens`
- default 30 days, server-side expiry
- **rotated on every refresh**: the old token is revoked, a successor is
  issued with a `rotated_from` link
- **reuse detection**: replaying an already-rotated token revokes the whole
  chain (walks `rotated_from` links both directions) — a stolen token is
  unusable after the legitimate client refreshes
- logout revokes the presented token

### Password storage

argon2id via `Bun.password` (`packages/core/src/security/password.ts`).
No legacy formats are accepted (scrypt/plaintext compatibility was removed
by request). `generateDevicePassword()` produces 24-byte base64url values.

### Authorization

`authenticateRequest()` verifies the Bearer JWT and loads the user;
`userCanAccessProject()` enforces `user_projects` membership. Protected
endpoints: command batches, firmware artifacts (upload/list), log queries,
firmware state, device credentials. Project-scoped operations return 403
for non-members; unknown resources return 404.

Tenancy today is **direct user → project membership** (`user_projects`).
The `organisations` tables remain scaffolding for a future multi-tenant
layer.

## Devices: per-session stateful (not JWT)

Why not JWT for devices:

| | JWT (stateless) | per-session |
| --- | --- | --- |
| Revocation | laggy, needs blacklists | immediate (refuse reconnect + kill session) |
| Reconnect | token-refresh dance | just CONNECT again |
| Credential exposure | token verifiable offline | credentials used only at CONNECT |
| MQTT model | mismatch | native (CONNECT/session lifecycle) |

### Flow

```
POST /v1/devices/:id/credentials   (authenticated human)
        └─▶ returns {mqtt_username = device_uid, mqtt_password} ONCE
             stores argon2id hash, clears auth_revoked
                    │
device CONNECT (username = device_uid, password)
        └─▶ broker authenticate: clientId === username (identity binding),
             not revoked, argon2id verify
                    │
        session lives until disconnect
                    │
POST /v1/devices/:id/credentials/revoke
        └─▶ auth_revoked = true + pg_notify(soulcloud_credentials_revoked, uid)
             broker kicks the live session (kickDeviceSession)
             reconnect is refused
```

### Identity binding

The MQTT `clientId` MUST equal the `username` (device UID) and pass
`isValidDeviceUid` — this is what makes session kill by clientId correct and
prevents impersonation (audit fix S1/S2).

### Credential rotation

Re-issuing credentials replaces the hash — the old password stops working
immediately (tested with real connections).

## Configuration

`JWT_SECRET` (≥ 32 chars, no default in production), `JWT_ACCESS_TTL_SECONDS`
(900), `JWT_REFRESH_TTL_SECONDS` (2592000). `createApp(prisma, jwtConfig)`
accepts the config; tests use their own short-TTL instances to exercise
expiry.

## Tests

`packages/api/tests/api/auth.test.ts` (15 tests): register (personal
project), login ok/wrong, duplicate 409, rotation + old-token reuse, chain
revocation, logout, protected endpoints 401/403, unknown/expired refresh
token, input validation, access-token expiry (1 s TTL), credentials 404.
`packages/broker/tests/mqtt/broker.test.ts` adds: revoked device refused at
CONNECT, re-issued credentials connect, credential rotation invalidates the
old password, session kill over WS, `kickDeviceSession` on offline device.
