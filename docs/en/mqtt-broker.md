# MQTT Broker

## Transport: MQTT over WebSocket only

The broker serves **MQTT 3.1.1 over WebSocket** at `ws://host:port/mqtt`
(port and path configurable: `MQTT_BROKER_PORT`, `MQTT_BROKER_PATH`). Raw TCP
was removed in audit fix S8. TLS terminates at the reverse proxy in front of
the WS endpoint.

Why a custom WS adapter (`packages/broker/src/mqtt/ws-adapter.ts`): the `ws`
npm package (used by aedes-server-factory / websocket-stream) is **not
supported under Bun** (`createWebSocketStream` throws). The adapter:

- bridges Bun-native WebSocket messages to a Node-style `Duplex` that
  `aedes.handle` consumes
- accepts multiple or partial MQTT packets across WS messages, as required by
  MQTT 3.1.1, while coalescing mqtt-packet's multi-`write()` output into one
  outbound message per packet to reduce framing and device wakeups
- closes the WS when aedes destroys the stream (aedes uses `destroy()`,
  which fires `'close'`, not `'final'`)
- treats `ws.send() === 0` (connection unusable) as a stream error and holds
  the Duplex write callback after `-1` (queued under backpressure) until
  Bun's `drain` callback, so aedes cannot overfill Bun's per-socket queue

Handshake, masking, fragmentation and ping/pong are handled by Bun's native
WebSocket (uWS core).

## Topics (v1)

| Direction | Topic | Status |
| --- | --- | --- |
| Platform → device | `soulcloud/v1/devices/{uid}/cmd/exec` | Implemented (command delivery) |
| Platform → device | `soulcloud/v1/devices/{uid}/ota` | Implemented (OTA notice: release/job metadata + per-device download JWT; device fetches the bin over HTTP itself) |
| Device → platform | `soulcloud/v1/devices/{uid}/ota/result` | Implemented (download/install/failure acknowledgements drive the target state machine) |
| Device → platform | `soulcloud/v1/devices/{uid}/cmd/result` | Implemented (idempotent result recording) |
| Device → platform | `soulcloud/v1/devices/{uid}/log` | Implemented (raw on9log ingestion) |
| Device → platform | `soulcloud/v1/devices/{uid}/stat` | Implemented (validated; persists `fw` → device_firmware_state) |

Topic constants/parsing/validation are centralized in
`packages/core/src/protocol/topic.ts`. A legal device UID is non-empty and
contains no `/`, `+`, `#` or whitespace.

## Device authentication and authorization

`packages/broker/src/mqtt/broker.ts`:

- **Identity binding (audit fix S1/S2)**: the MQTT `clientId` MUST equal the
  `username` (the device UID) and pass `isValidDeviceUid`. All authorization
  trusts `client.id`; without the binding any credential holder could
  impersonate any other device (including wildcard clientIds).
- **Authenticate**: looks up `devices` by UID, refuses `auth_revoked`
  devices, verifies the argon2id password (`verifyDevicePassword`). Failed
  auth gets a fixed 100 ms delay (brute-force throttle); database failures
  return CONNACK code 3 (server unavailable), not code 4.
- **authorizePublish**: devices may only publish to their own uplink topics
  (`cmd/result`, `log`, `stat`); server-side publishes (`client === null`)
  pass; oversized payloads are early-rejected (256 KB ceiling before the
  configurable `UPLINK_MAX_PACKET_BYTES` check in dispatch).
- **authorizeSubscribe**: devices may only subscribe to their own **downlink**
  topics (`cmd/exec`, `ota`) — no echoing their own uplinks.

## Uplink dispatch

`packages/broker/src/mqtt/dispatch.ts` routes device messages:

- `cmd/result` → strict MessagePack decode → `recordDeviceResult` (idempotent)
- `log` → container dispatch (`packages/core/src/logging/container.ts`: first
  byte 0x9a = raw on9log packet, 0x01 = MsgPack bundle of on9log packets) →
  each element validated and stored as its own raw event (hot path, no ELF
  work; one bad element is dropped, the rest of the bundle survives)
- `stat` → strict decode → upsert `device_firmware_state` (fw hash)

Per-device guards (DDoS): `UPLINK_MAX_PACKET_BYTES` (64 KB default) and a
token-bucket rate limiter (`UPLINK_RATE_PER_SECOND` 20, `UPLINK_RATE_BURST`
100) — excess is dropped and logged, never buffered.

## Command publication

`packages/broker/src/mqtt/publish.ts` runs a poll cycle:

1. expire overdue commands (`delivery_failed`, see command queue doc)
2. `leaseNext` the oldest eligible command
3. if the device is **offline, do not publish** — defer the command (retry
   delay `offlineRetryMs`, default 5 s) instead of stranding it in
   `broker_accepted` (audit fix M2)
4. `aedes.publish()` at QoS 1; the callback success **is** broker acceptance
   (embedded broker — no external PUBACK round trip)
5. `markBrokerAccepted`

## LISTEN/NOTIFY

`packages/broker/src/mqtt/notify.ts` runs one dedicated pg connection
LISTENing on two channels (reconnecting with a fresh `Client` after errors):

- `soulcloud_commands` → `poller.wake()` (immediate poll)
- `soulcloud_credentials_revoked` → `kickDeviceSession()` (kill live session)

## Session kill (G group)

`kickDeviceSession(aedes, deviceUid)` closes the device's Aedes client
(identity binding makes clientId == device UID). The API revoke endpoint
writes `auth_revoked = true` and `pg_notify`s the UID in one transaction;
the broker kicks the live session. If the notification is lost, reconnects
are still refused.

## Known limitations

- Revocation of an online session depends on the NOTIFY reaching the broker
  (lossy by design); the refusal-on-reconnect path is the correctness
  fallback.
- MQTT 5, QoS 2 and retained-message policy are not implemented (QoS 1
  suffices; retain is configurable via `MQTT_COMMAND_RETAIN`).
- Rollout phases create ordinary ota_jobs through the same machinery — the
  broker is unaware of rollouts (by design; see the rollout document).
