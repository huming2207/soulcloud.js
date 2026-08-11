# Logging (on9log)

Devices log in the **on9log binary format** (the firmware component in
`on9log_demo/components/on9log`): compact 18-byte headers with ELF addresses
instead of format strings. The platform stores raw packets immutably and
decodes on demand against uploaded firmware ELFs.

## Protocol summary

```
18-byte little-endian header:
  magic 0x9a | type_level (type<<4 | level) | seq u16 | time_ms u32 |
  tag_id u32 | fmt_id u32 | payload_len u16 (0xffff = streaming)
```

Packet types: `0 LOG` (arg table + encoded args), `1 DROPPED` (dropped
counter), `2 TIME_SYNC`, `3 BOOT` (opaque payload — format not yet defined),
`4 BUFFER` (chunked memory dumps). Argument types: 32-bit, 64-bit, pointer,
dynamic string (u32 length + bytes), string view.

MQTT carries the raw packet bytes directly (no SLIP — MQTT already has
message boundaries; SLIP exists only for UART transports and lives in test
helpers).

## Log container protocol (uplink)

The MQTT `log` topic payload is a **dispatch container**: the first byte
selects the format, leaving room for future types (raw text, JSON, …).

| First byte | Format |
| --- | --- |
| `0x9a` | Raw on9log packet — unchanged, the on9log magic itself |
| `0x01` | MessagePack aggregated array: `array of bin` (`bin8`/`bin16`), one complete on9log packet per element |
| other | Reserved — the packet is rejected |

Aggregated arrays let the firmware batch many log packets into one MQTT
publish (typically when its outbound queue backs up). The broker splits the
container and ingests each element through the normal single-packet path
(`ingestLogPacket`), so `raw_log_events`, decoding and the realtime log
stream are unchanged. A malformed element is dropped and counted; it never
invalidates the rest of the container. Elements must be `bin8`/`bin16`
(self-delimiting) and the element count is capped at 4096 per container.

See [protocol-log-packaging.md](protocol-log-packaging.md) for the
firmware-facing wire specification (byte-level examples, encoder choices,
merge guidance).

## Pipeline

```
device ── MQTT log topic ──▶ broker (validate + store raw, <1ms)
                                  │
ELF upload ──▶ API (SHA-256 → store → synchronous dictionary import)
                                  │
query ──▶ API (tag/fmt IDs → dictionary → renderFormat → response)
```

- **Hot path** (`packages/core/src/logging/ingest.ts`): strict packet
  parsing, one insert into `raw_log_events` with envelope metadata, artifact
  association from `device_firmware_state` (fw hash → build_id → project-
  scoped artifact). No ELF work, no rendering.
- **Import** (`packages/core/src/logging/artifact.ts`): SHA-256 build
  identity (unique per project), extraction of `.noload_keep_in_elf.*`
  strings (formats + tags) and allocated read-only strings, transactional,
  idempotent under concurrent uploads (P2002 → existing row).
- **Decode** (`packages/core/src/logging/decode.ts`): query-time dictionary
  lookup + `renderFormat` (printf + fmt syntax). Undecodable events return
  `message: null` — never an error — and raw data remains for backfill.
  Batch decoding loads dictionaries once per artifact (no N+1).

## Renderer

`packages/core/src/on9log/render.ts` supports:

- printf conversions (`%d %u %x %X %p %c %s %f %e %g`, flags/width/precision,
  `%.*s` / `%*d` consume args; negative width = left-justify; `%+08d` pads
  zeros after the sign)
- fmt-style placeholders (`{}`, `{:x}`, `{:#x}`, `{:>10}`, `{:.6f}`,
  nested `{:{}}`, positional `{0:{1}}`, brace escaping)
- a documented heuristic for bare 64-bit `{}` (the wire cannot distinguish
  int64/uint64/double; magnitudes ≥ 2^53 with a plausible float exponent
  render as floats, NaN/Inf handled, small integers stay integers)

Security: field width capped at 4096, precision 0..100, total output capped
at 1 MB — malicious format strings produce typed errors, never OOM.

## ELF parser

`packages/core/src/elf/parser.ts` is a dependency-free ELF32/64 LE/BE parser:
vaddr → file offset via PT_LOAD segments with an allocated-section fallback
(needed for `.noload` sections, which are not in any load segment). All
offsets are bounds-checked; extraction is limited to recognized sections
(no DWARF/strings import — they can contain build paths and credentials).
Benchmarked: parsing a 1 MB real ELF ≈ 36 µs; full decode ≈ 40 µs/event.

## Security (audit-driven)

- Per-device rate limits and packet-size caps at the broker (see MQTT doc)
- Dynamic string length capped (64 KB, firmware cap is 1024)
- Parser is strictly bounded (no allocation from lengths)
- BOOT packets stored opaquely; DROPPED/TIME_SYNC/BUFFER payloads are
  length-checked; BUFFER chunks validated against the declared total;
  LOG levels validated 0..5

## Known limitations / open items

- The container dispatch reserves all first-byte values other than `0x9a`
  and `0x01`; new types (e.g. raw text, JSON) can be added without another
  breaking change
- Full-text search (tsvector) is not implemented; the raw archive is the
  source of truth and a decode projection can be added later
- Object storage archival and retention policies are deferred until volume
  justifies them
- `decodeState` backfill links devices by current firmware hash; historical
  events from older firmware render against the newest ELF if the old one
  was never uploaded (documented simplification)
