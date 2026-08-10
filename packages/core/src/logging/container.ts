/**
 * Log upload container protocol: the first byte of a `/log` payload selects
 * the packet type.
 *
 *   magic 0x9a  raw on9log packet (unchanged single-packet upload)
 *   magic 0x01  MsgPack aggregated array: array of bin8/bin16 elements,
 *               each element is one complete raw on9log packet
 *   any other  reserved for future types (raw text, JSON, ...)
 *
 * The bundle is scanned structurally (like protocol/structure.ts) instead of
 * decoded with @msgpack/msgpack, for two reasons:
 *   1. decoding cannot distinguish bin8/bin16 from bin32 (all decode to
 *      Uint8Array), and bin32 is outside the wire contract;
 *   2. a hostile array32 length field must never drive an allocation.
 * Elements are self-delimiting (bin length prefix), so a malformed element
 * is skipped and counted in `dropped` without aborting the bundle — a
 * partial bundle still delivers the well-formed packets it contains.
 */

import { ON9LOG_PACKET_MAGIC } from "../on9log/packet";

/** Magic byte of a raw (single) on9log packet upload. */
export const LOG_PACKET_RAW_MAGIC = ON9LOG_PACKET_MAGIC;

/** Magic byte of a MsgPack aggregated-array upload. */
export const LOG_PACKET_MSG_MAGIC = 0x01;

/** Maximum number of elements accepted in one bundle (DoS guard). */
export const MAX_BUNDLE_ELEMENTS = 4096;

/** Maximum nesting depth walked when skipping a non-bin element. */
const MAX_SKIP_DEPTH = 128;

export class LogContainerError extends Error {
  constructor(
    public readonly kind:
      | "invalid_magic"
      | "invalid_msgpack"
      | "too_many_elements",
    message: string,
  ) {
    super(message);
    this.name = "LogContainerError";
  }
}

export interface LogContainer {
  /** Complete raw on9log packets (each is a full packet byte string). */
  elements: Uint8Array[];
  /** Elements skipped because they were not well-formed bin8/bin16. */
  dropped: number;
}

/**
 * Splits a `/log` payload into its constituent on9log packets.
 *
 * Raw mode passes the payload through unchanged (no on9log validation here —
 * the ingest path parses each element). Bundle mode validates the msgpack
 * structure only; per-element on9log validation still happens at ingest.
 *
 * @throws {LogContainerError} on an unknown magic, a malformed bundle, or a
 *   bundle that declares more than {@link MAX_BUNDLE_ELEMENTS} elements.
 */
export function parseLogContainer(bytes: Uint8Array): LogContainer {
  if (bytes.length === 0) {
    throw new LogContainerError("invalid_magic", "empty log payload has no packet magic");
  }
  const magic = bytes[0]!;
  if (magic === LOG_PACKET_RAW_MAGIC) {
    return { elements: [bytes], dropped: 0 };
  }
  if (magic !== LOG_PACKET_MSG_MAGIC) {
    throw new LogContainerError(
      "invalid_magic",
      `unknown log packet magic 0x${magic.toString(16).padStart(2, "0")}`,
    );
  }
  return parseMsgBundle(bytes.subarray(1));
}

/** Minimal byte reader over the bundle payload (never trusts length fields
 *  before the bytes behind them have been verified to exist). */
class Reader {
  private pos = 0;
  constructor(private readonly bytes: Uint8Array) {}

  get remaining(): number {
    return this.bytes.length - this.pos;
  }

  u8(): number | null {
    if (this.remaining < 1) return null;
    return this.bytes[this.pos++]!;
  }

  u16(): number | null {
    if (this.remaining < 2) return null;
    const v = ((this.bytes[this.pos]! << 8) | this.bytes[this.pos + 1]!) >>> 0;
    this.pos += 2;
    return v;
  }

  u32(): number | null {
    if (this.remaining < 4) return null;
    const v =
      ((this.bytes[this.pos]! << 24) |
        (this.bytes[this.pos + 1]! << 16) |
        (this.bytes[this.pos + 2]! << 8) |
        this.bytes[this.pos + 3]!) >>>
      0;
    this.pos += 4;
    return v;
  }

  take(len: number): Uint8Array | null {
    if (len > this.remaining) return null;
    const v = this.bytes.subarray(this.pos, this.pos + len);
    this.pos += len;
    return v;
  }

  get atEnd(): boolean {
    return this.pos === this.bytes.length;
  }
}

function parseMsgBundle(payload: Uint8Array): LogContainer {
  const reader = new Reader(payload);
  const first = reader.u8();
  let declared: number | null = null;
  if (first !== null && first >= 0x90 && first <= 0x9f) {
    declared = first & 0x0f; // fixarray (0-15 elements)
  } else if (first === 0xdc) {
    declared = reader.u16(); // array16
  } else if (first === 0xdd) {
    declared = reader.u32(); // array32
  } else {
    throw new LogContainerError("invalid_msgpack", "bundle root must be a msgpack array");
  }
  if (declared === null) {
    throw new LogContainerError("invalid_msgpack", "truncated msgpack array header");
  }
  if (declared > MAX_BUNDLE_ELEMENTS) {
    throw new LogContainerError(
      "too_many_elements",
      `bundle declares ${declared} elements, limit ${MAX_BUNDLE_ELEMENTS}`,
    );
  }
  // an empty bundle can only be a firmware bug or a hostile probe: it
  // carries no packets, so reject it outright instead of silently no-oping
  if (declared === 0) {
    throw new LogContainerError("invalid_msgpack", "empty bundle is not a valid log upload");
  }

  const elements: Uint8Array[] = [];
  let dropped = 0;
  for (let i = 0; i < declared; i++) {
    const type = reader.u8();
    if (type === null) {
      throw new LogContainerError("invalid_msgpack", `bundle truncated at element ${i}`);
    }
    if (type === 0xc4 || type === 0xc5) {
      // bin8 / bin16 — the only element kinds in the wire contract
      const len = type === 0xc4 ? reader.u8() : reader.u16();
      if (len === null) {
        throw new LogContainerError("invalid_msgpack", `bundle truncated in element ${i} length`);
      }
      const data = reader.take(len);
      if (data === null) {
        throw new LogContainerError("invalid_msgpack", `bundle truncated in element ${i} payload`);
      }
      if (len === 0) {
        dropped++; // empty element: skip, keep scanning
        continue;
      }
      elements.push(data);
      continue;
    }
    // not a bin8/bin16 element: skip the whole value and count it
    dropped++;
    if (type === 0xc6) {
      // bin32 is outside the contract; skip its 4-byte length + payload
      const binLen = reader.u32();
      if (binLen === null || reader.take(binLen) === null) {
        throw new LogContainerError("invalid_msgpack", `bundle truncated in bin32 element ${i}`);
      }
      continue;
    }
    // any other msgpack value (int, str, map, nested array, ext, ...)
    if (!skipMsgValue(reader, type, 1)) {
      throw new LogContainerError("invalid_msgpack", `bundle truncated in element ${i}`);
    }
  }
  if (!reader.atEnd) {
    throw new LogContainerError("invalid_msgpack", "trailing bytes after bundle array");
  }
  return { elements, dropped };
}

/** Skips one complete msgpack value whose first byte has been consumed.
 *  Returns false on truncation or excessive nesting. */
function skipMsgValue(reader: Reader, first: number, depth: number): boolean {
  if (depth > MAX_SKIP_DEPTH) return false;
  // fixints
  if (first <= 0x7f || first >= 0xe0) return true;
  // fixstr / fixarray / fixmap
  if (first >= 0xa0 && first <= 0xbf) return reader.take(first & 0x1f) !== null;
  if (first >= 0x90 && first <= 0x9f) {
    for (let i = 0; i < (first & 0x0f); i++) {
      const b = reader.u8();
      if (b === null || !skipMsgValue(reader, b, depth + 1)) return false;
    }
    return true;
  }
  if (first >= 0x80 && first <= 0x8f) {
    for (let i = 0; i < (first & 0x0f) * 2; i++) {
      const b = reader.u8();
      if (b === null || !skipMsgValue(reader, b, depth + 1)) return false;
    }
    return true;
  }
  switch (first) {
    case 0xc0: // nil
    case 0xc2: // false
    case 0xc3: // true
      return true;
    case 0xc4: { // bin8
      const len = reader.u8();
      return len !== null && reader.take(len) !== null;
    }
    case 0xc5: { // bin16
      const len = reader.u16();
      return len !== null && reader.take(len) !== null;
    }
    case 0xc6: { // bin32
      const len = reader.u32();
      return len !== null && reader.take(len) !== null;
    }
    case 0xca: // float32
    case 0xcb: // float64
      return reader.take(first === 0xca ? 4 : 8) !== null;
    case 0xcc: // uint8
    case 0xd0: // int8
      return reader.u8() !== null;
    case 0xcd: // uint16
    case 0xd1: // int16
      return reader.u16() !== null;
    case 0xce: // uint32
    case 0xd2: // int32
      return reader.u32() !== null;
    case 0xcf: // uint64
    case 0xd3: // int64
      return reader.take(8) !== null;
    case 0xd4: // fixext1
    case 0xd5: // fixext2
    case 0xd6: // fixext4
    case 0xd7: // fixext8
    case 0xd8: // fixext16
      return reader.take([2, 3, 5, 9, 17][first - 0xd4]!) !== null;
    case 0xc7: { // ext8: len + type + data
      const len = reader.u8();
      if (len === null || reader.take(len + 1) === null) return false;
      return true;
    }
    case 0xc8: { // ext16
      const len = reader.u16();
      if (len === null || reader.take(len + 1) === null) return false;
      return true;
    }
    case 0xc9: { // ext32
      const len = reader.u32();
      if (len === null || reader.take(len + 1) === null) return false;
      return true;
    }
    case 0xd9: { // str8
      const len = reader.u8();
      return len !== null && reader.take(len) !== null;
    }
    case 0xda: { // str16
      const len = reader.u16();
      return len !== null && reader.take(len) !== null;
    }
    case 0xdb: { // str32
      const len = reader.u32();
      return len !== null && reader.take(len) !== null;
    }
    case 0xdc: { // array16
      const len = reader.u16();
      if (len === null) return false;
      for (let i = 0; i < len; i++) {
        const b = reader.u8();
        if (b === null || !skipMsgValue(reader, b, depth + 1)) return false;
      }
      return true;
    }
    case 0xdd: { // array32
      const len = reader.u32();
      if (len === null) return false;
      for (let i = 0; i < len; i++) {
        const b = reader.u8();
        if (b === null || !skipMsgValue(reader, b, depth + 1)) return false;
      }
      return true;
    }
    case 0xde: { // map16
      const len = reader.u16();
      if (len === null) return false;
      for (let i = 0; i < len * 2; i++) {
        const b = reader.u8();
        if (b === null || !skipMsgValue(reader, b, depth + 1)) return false;
      }
      return true;
    }
    case 0xdf: { // map32
      const len = reader.u32();
      if (len === null) return false;
      for (let i = 0; i < len * 2; i++) {
        const b = reader.u8();
        if (b === null || !skipMsgValue(reader, b, depth + 1)) return false;
      }
      return true;
    }
    default:
      return false; // 0xc1 is never used in msgpack
  }
}
