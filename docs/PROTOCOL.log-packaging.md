# Soulcloud Log Uplink Packaging Protocol

**Date**: 2026-08-09 · **Status**: agreed design, implementation in progress
(platform + firmware) · **Audience**: firmware developers

This document specifies how log data travels from a device to the Soulcloud
platform over the MQTT `log` topic
(`soulcloud/v1/devices/{device_uid}/log`, QoS 1). It replaces the previous
"raw packet only" contract with a versioned **dispatch container**: the
first byte selects the payload format, so new formats can be added later
without another breaking change.

## 1. Container dispatch

Every payload published to the `log` topic starts with a type byte:

| First byte | Format | Status |
| --- | --- | --- |
| `0x9a` | Raw on9log packet (the on9log magic; a single packet, as before) | supported |
| `0x01` | MessagePack aggregated array (many on9log packets in one publish) | supported |
| anything else | Reserved for future formats (raw text, JSON, …) | must not be sent |

## 2. Type `0x9a` — raw on9log packet

The payload is exactly one on9log packet as defined by the on9log component:

```
18-byte little-endian header:
  uint8  magic       = 0x9a
  uint8  type_level  (high nibble: packet type, low nibble: level)
  uint16 seq         (wraps naturally)
  uint32 time_ms     (ms since boot, wraps naturally)
  uint32 tag_id      (ELF address of the tag string)
  uint32 fmt_id      (ELF address of the format string)
  uint16 payload_len (0xffff = streaming; otherwise the payload length)
```

followed by the packet payload (LOG args, DROPPED counter, TIME_SYNC fields,
BUFFER chunk, or opaque BOOT bytes). Send this form for a single packet —
there is no reason to wrap a single packet in a container.

## 3. Type `0x01` — MessagePack aggregated array

The payload is a MessagePack **array of binary blobs**; each element is one
complete on9log packet (type `0x9a` form, see §2).

- Array header: `fixarray` (`0x90 | n`, n ≤ 15) or `array16`
  (`0xdc` + 2-byte big-endian count) for 16–4096 elements. (An `array32`
  root with ≤ 4096 elements is also accepted.)
- Each element: `bin8` (`0xc4` + 1-byte length, blob ≤ 255 bytes) or `bin16`
  (`0xc5` + 2-byte big-endian length, blob ≤ 65535 bytes). The binary
  length is the element's byte length, so elements are self-delimiting.
- An element must not be empty and must start with the on9log magic `0x9a`.
- The platform drops and counts malformed elements (wrong type, empty, bad
  magic, truncated on9log content) and keeps the rest of the container —
  one bad element never invalidates its siblings.
- Element count is capped at **4096** per container. The broker's transport
  layer keeps a 256 KB early-reject ceiling, but the *binding* per-publish
  bound for a device uplink is the configurable `UPLINK_MAX_PACKET_BYTES`
  (default 64 KB) enforced by the dispatch layer — size a container against
  that, not against 256 KB.
- Rate limiting counts **publishes**, not elements: one container consumes
  one rate-limit token for up to 4096 packets. That is intentional (batching
  is the whole point), and the 64 KB publish cap bounds the amplification.
- Each element is an independent on9log packet with its **own `seq` and
  `time_ms`** — the container adds no timestamps or sequence numbers of its
  own.

### 3.1 Byte-level example

Three on9log LOG packets bundled into one `0x01` container:

```
Packet A — LOG, level INFO, no arguments (20 bytes):
  9a 03 01 00 64 00 00 00 00 10 00 00 00 20 00 00 02 00 01 00
  ─┬─ ─┬─ ───┬─── ─────┬───── ────┬──── ────┬──── ──┬── ─┬─ ─┬─
   │   │      │         │          │         │       │   │   └── arg_types[0] = 0x00 (NONE sentinel)
   │   │      │         │          │         │       │   └── arg_count = 0x01 (NONE-typed arg; a
   │   │      │         │          │         │       │       zero-arg LOG must still carry the
   │   │      │         │          │         │       │       sentinel type byte — payload 0x00 alone
   │   │      │         │          │         │       │       is rejected by the strict parser)
   │   │      │         │          │         │       └── payload_len = 0x0002
   │   │      │         │          │         └── fmt_id = 0x00002000
   │   │      │         │          └── tag_id = 0x00001000
   │   │      │         └── time_ms = 100 (0x64, u32 LE)
   │   │      └── seq = 1 (u16 LE)
   │   └── type_level = 0x03 (type 0 LOG << 4 | level 3 INFO)
   └── magic 0x9a

Packet B — LOG, one 32-bit argument = 42 (24 bytes):
  9a 03 02 00 65 00 00 00 00 10 00 00 00 20 00 00 06 00 01 01 2a 00 00 00
  ─┬─ ─┬─ ───┬─── ─────┬───── ────┬──── ────┬──── ──┬── ─┬─ ─┬─ ────┬────
   │   │      │         │          │         │       │   │   │      └── arg value = 42 (0x2a, u32 LE)
   │   │      │         │          │         │       │   │   └── arg_types[0] = 0x01 (32BITS)
   │   │      │         │          │         │       │   └── arg_count = 0x01
   │   │      │         │          │         │       └── payload_len = 0x0006
   │   │      │         │          │         └── fmt_id = 0x00002000
   │   │      │         │          └── tag_id = 0x00001000
   │   │      │         └── time_ms = 101 (0x65)
   │   │      └── seq = 2
   │   └── type_level = 0x03 (LOG, INFO)
   └── magic 0x9a
   │   │      │         │          │         └── fmt_id = 0x00002000
   │   │      │         │          └── tag_id = 0x00001000
   │   │      │         └── time_ms = 101 (0x65)
   │   │      └── seq = 2
   │   └── type_level = 0x03 (LOG, INFO)
   └── magic 0x9a

Packet C — LOG, one dynamic string "ok" (26 bytes):
  9a 03 03 00 66 00 00 00 00 10 00 00 00 20 00 00 08 00 01 04 02 00 00 00 6f 6b
  ─┬─ ─┬─ ───┬─── ─────┬───── ────┬──── ────┬──── ──┬── ─┬─ ─┬─ ────┬──── ────┬───
   │   │      │         │          │         │       │   │   │      │         └── "ok" (0x6f 0x6b)
   │   │      │         │          │         │       │   │   │      └── string length = 2 (0x02, u32 LE)
   │   │      │         │          │         │       │   │   └── arg_types[0] = 0x04 (DYNAMIC_STRING)
   │   │      │         │          │         │       │   └── arg_count = 0x01
   │   │      │         │          │         │       └── payload_len = 0x0008
   │   │      │         │          │         └── fmt_id = 0x00002000
   │   │      │         │          └── tag_id = 0x00001000
   │   │      │         └── time_ms = 102 (0x66)
   │   │      └── seq = 3
   │   └── type_level = 0x03 (LOG, INFO)
   └── magic 0x9a

Container (78 bytes total):
  01 93 c4 14 <packet A: 20 bytes> c4 18 <packet B: 24 bytes> c4 1a <packet C: 26 bytes>
  ─┬─ ─┬─ ─┬─
   │   │   └── bin8: element length 0x14/0x18/0x1a (20/24/26) + the on9log packet bytes
   │   └── fixarray: 3 elements (0x93 = 0x90 | 3)
   └── container type 0x01
```

Decoded byte stream (hex):

```
01 93
c4 14  9a 03 01 00 64 00 00 00 00 10 00 00 00 20 00 00 02 00 00 00
c4 18  9a 03 02 00 65 00 00 00 00 10 00 00 00 20 00 00 06 00 01 01 2a 00 00 00
c4 1a  9a 03 03 00 66 00 00 00 00 10 00 00 00 20 00 00 08 00 01 04 02 00 00 00 6f 6b
```

## 4. Firmware implementation guidance

- **Encoder**: use a mature MessagePack encoder — `msgpack-c` on C/C++
  (`msgpack_pack_array`, `msgpack_pack_bin`), `rmp-serde` or `rmp` on Rust.
  Only `array` and `bin` are needed; nothing else in the MessagePack spec is
  used on this topic.
- **When to merge — backpressure, not a fixed timer.** Real-time delivery is
  a feature: the platform streams logs to the web console as they arrive.
  Keep publishing single raw packets (type `0x9a`) as the default so a log
  line shows up immediately. Only when the device's outbound queue backs up
  (suggested threshold: **more than 16 queued packets**) drain the queue as
  one `0x01` container. A 10-second fixed window is the wrong shape: it adds
  latency in the common case and buys nothing when traffic is sparse.
- **One publish, one container**: a container is sent as a single MQTT
  PUBLISH on the `log` topic, QoS 1, exactly like a raw packet. QoS and
  topic semantics are unchanged.
- **Bounded memory**: flush the container when it reaches ~4 KB of payload
  or 128 elements, whichever comes first, so a pathological burst cannot
  stall the queue behind one giant packet (the platform's 256 KB ceiling is
  far away; keep a comfortable margin).
- **Batching is best-effort**: if the device crashes with a filled queue,
  the buffered logs are lost. Never batch when the log matters most (fault
  diagnosis) — that is exactly when the queue fills, so prefer flushing
  partial containers promptly over waiting for a full one.
- **Element validity**: each element must be a complete on9log packet
  starting with `0x9a`. Never split a packet across elements or containers;
  a packet whose `payload_len` is not `0xffff` must be sent whole.

## 5. Platform-side handling (for reference)

- The broker dispatches on the first byte, splits `0x01` containers, and
  ingests each element through the **same single-packet path** as type
  `0x9a`: validation → one row in `raw_log_events` per packet → realtime
  notification for the log stream. Malformed elements are dropped and
  counted, never fatal for the container or the connection.
- Because each element keeps its own on9log `seq` and `time_ms`, decoding
  (ELF dictionary lookup + format rendering), sequence-gap detection and
  the realtime log stream work unchanged. The container format is invisible
  to every downstream consumer.

## 6. Change history

| Date | Change |
| --- | --- |
| 2026-08-09 | Initial container protocol: `0x9a` raw (unchanged) + `0x01` MessagePack aggregated array; all other first bytes reserved |
