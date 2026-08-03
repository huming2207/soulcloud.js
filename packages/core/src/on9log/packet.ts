/**
 * on9log binary packet parser.
 *
 * Wire format (verified against the on9log_demo Unix build):
 *
 *   18-byte little-endian header:
 *     uint8  magic       = 0x9a
 *     uint8  type_level  (high nibble: packet type, low nibble: level)
 *     uint16 seq         (wraps naturally)
 *     uint32 time_ms     (ms since boot, wraps naturally)
 *     uint32 tag_id      (ELF address of the tag string)
 *     uint32 fmt_id      (ELF address of the format string)
 *     uint16 payload_len (0xffff = streaming)
 *
 * Payloads:
 *   LOG:      uint8 arg_count + uint8 arg_types[arg_count] + encoded args
 *   DROPPED:  uint32 dropped_count
 *   TIME_SYNC: uint32 boot_time_ms + uint32 utc_unix_ms
 *   BUFFER:   uint32 total_len + uint32 offset + uint32 chunk_len + bytes
 *
 * Argument encoding by arg type:
 *   0 NONE (sentinel), 1 32BITS (4B), 2 64BITS (8B), 3 POINTER (4B),
 *   4/5 DYNAMIC_STRING(_VIEW): uint32 length + bytes (0xffffffff = null)
 */

/** Maximum accepted dynamic string length (firmware cap is 1024; host cap
 * is defensive against malicious length fields). */
export const MAX_DYNAMIC_STRING_LEN = 65536;

export const ON9LOG_PACKET_MAGIC = 0x9a;
export const ON9LOG_PAYLOAD_LEN_STREAMING = 0xffff;
export const ON9LOG_HEADER_SIZE = 18;

export const enum On9logPacketType {
  Log = 0,
  Dropped = 1,
  TimeSync = 2,
  Boot = 3,
  Buffer = 4,
}

export const enum On9logLevel {
  None = 0,
  Error = 1,
  Warn = 2,
  Info = 3,
  Debug = 4,
  Verbose = 5,
}

export const enum On9logArgType {
  None = 0,
  Bits32 = 1,
  Bits64 = 2,
  Pointer = 3,
  DynamicString = 4,
  DynamicStringView = 5,
}

export const ON9LOG_LEVEL_NAMES: Record<number, string> = {
  0: "NONE",
  1: "ERROR",
  2: "WARN",
  3: "INFO",
  4: "DEBUG",
  5: "VERBOSE",
};

export interface On9logPacketHeader {
  type: On9logPacketType;
  level: number;
  seq: number;
  timeMs: number;
  tagId: number;
  fmtId: number;
  payloadLen: number;
}

export type On9logArg =
  | { type: On9logArgType.Bits32; value: number }
  | { type: On9logArgType.Bits64; value: bigint }
  | { type: On9logArgType.Pointer; value: number }
  | { type: On9logArgType.DynamicString; value: Uint8Array | null }
  | { type: On9logArgType.DynamicStringView; value: Uint8Array | null };

export interface On9logLogPacket {
  header: On9logPacketHeader;
  kind: "log";
  argCount: number;
  argTypes: Uint8Array;
  args: On9logArg[];
}

export interface On9logDroppedPacket {
  header: On9logPacketHeader;
  kind: "dropped";
  droppedCount: number;
}

export interface On9logTimeSyncPacket {
  header: On9logPacketHeader;
  kind: "time_sync";
  bootTimeMs: number;
  utcUnixMs: number;
}

export interface On9logBufferPacket {
  header: On9logPacketHeader;
  kind: "buffer";
  totalLen: number;
  offset: number;
  chunk: Uint8Array;
}

export type On9logPacket =
  | On9logLogPacket
  | On9logDroppedPacket
  | On9logTimeSyncPacket
  | On9logBufferPacket;

export class On9logParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "On9logParseError";
  }
}

class Reader {
  constructor(
    public readonly buf: Uint8Array,
    public pos = 0,
  ) {}

  u8(): number {
    this.require(1);
    return this.buf[this.pos++]!;
  }

  u16(): number {
    this.require(2);
    const v = this.buf[this.pos]! | (this.buf[this.pos + 1]! << 8);
    this.pos += 2;
    return v;
  }

  u32(): number {
    this.require(4);
    const v =
      this.buf[this.pos]! |
      (this.buf[this.pos + 1]! << 8) |
      (this.buf[this.pos + 2]! << 16) |
      (this.buf[this.pos + 3]! << 24);
    this.pos += 4;
    return v >>> 0;
  }

  bytes(n: number): Uint8Array {
    this.require(n);
    const out = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }

  private require(n: number): void {
    if (this.pos + n > this.buf.length) {
      throw new On9logParseError(
        `truncated on9log packet: need ${n} bytes at offset ${this.pos}, have ${this.buf.length - this.pos}`,
      );
    }
  }
}

/**
 * Parses the fixed 18-byte packet header.
 *
 * @throws {On9logParseError} on truncation or bad magic.
 */
export function parseOn9logHeader(packet: Uint8Array): On9logPacketHeader {
  const reader = new Reader(packet);
  const magic = reader.u8();
  if (magic !== ON9LOG_PACKET_MAGIC) {
    throw new On9logParseError(
      `invalid on9log magic 0x${magic.toString(16)}, expected 0x9a`,
    );
  }
  const typeLevel = reader.u8();
  return {
    type: typeLevel >> 4,
    level: typeLevel & 0x0f,
    seq: reader.u16(),
    timeMs: reader.u32(),
    tagId: reader.u32(),
    fmtId: reader.u32(),
    payloadLen: reader.u16(),
  };
}

/**
 * Parses a complete on9log packet (header + payload).
 *
 * For streaming packets (payload_len == 0xffff) the caller must pass exactly
 * the framed packet bytes (the transport boundary defines the payload end).
 *
 * @throws {On9logParseError} on malformed or truncated packets.
 */
export function parseOn9logPacket(packet: Uint8Array): On9logPacket {
  const header = parseOn9logHeader(packet);
  if (header.payloadLen !== ON9LOG_PAYLOAD_LEN_STREAMING) {
    // non-streaming packets must match the declared payload length exactly
    const expected = ON9LOG_HEADER_SIZE + header.payloadLen;
    if (packet.length !== expected) {
      throw new On9logParseError(
        `on9log packet length ${packet.length} does not match declared payload length ${header.payloadLen}`,
      );
    }
  }
  const payload = packet.subarray(ON9LOG_HEADER_SIZE);

  switch (header.type) {
    case On9logPacketType.Log:
      return parseLogPacket(header, payload);
    case On9logPacketType.Dropped:
      return parseDroppedPacket(header, payload);
    case On9logPacketType.TimeSync:
      return parseTimeSyncPacket(header, payload);
    case On9logPacketType.Buffer:
      return parseBufferPacket(header, payload);
    default:
      throw new On9logParseError(
        `unknown on9log packet type ${header.type}`,
      );
  }
}

function parseLogPacket(
  header: On9logPacketHeader,
  payload: Uint8Array,
): On9logLogPacket {
  const reader = new Reader(payload);
  const argCount = reader.u8();
  // The type table is NUL-terminated: decoding stops at the NONE sentinel
  // even when argCount is larger (the firmware macro always appends a 0).
  const argTypes: number[] = [];
  for (let i = 0; i < argCount; i++) {
    const t = reader.u8();
    if (t === On9logArgType.None) break;
    argTypes.push(t);
  }
  const args: On9logArg[] = [];
  for (const t of argTypes) {
    args.push(decodeArg(reader, t));
  }
  if (header.payloadLen !== ON9LOG_PAYLOAD_LEN_STREAMING && reader.pos !== payload.length) {
    throw new On9logParseError(
      `on9log LOG payload has ${payload.length - reader.pos} trailing bytes`,
    );
  }
  return {
    header,
    kind: "log",
    argCount,
    argTypes: Uint8Array.from(argTypes),
    args,
  };
}

function decodeArg(reader: Reader, type: number): On9logArg {
  switch (type) {
    case On9logArgType.Bits32:
      return { type: On9logArgType.Bits32, value: reader.u32() };
    case On9logArgType.Bits64: {
      const lo = reader.u32();
      const hi = reader.u32();
      return { type: On9logArgType.Bits64, value: (BigInt(hi) << 32n) | BigInt(lo) };
    }
    case On9logArgType.Pointer:
      return { type: On9logArgType.Pointer, value: reader.u32() };
    case On9logArgType.DynamicString:
    case On9logArgType.DynamicStringView: {
      const len = reader.u32();
      if (len === 0xffffffff) {
        return { type, value: null };
      }
      if (len > MAX_DYNAMIC_STRING_LEN) {
        throw new On9logParseError(
          `on9log dynamic string length ${len} exceeds limit ${MAX_DYNAMIC_STRING_LEN}`,
        );
      }
      return { type, value: reader.bytes(len) };
    }
    default:
      throw new On9logParseError(`unknown on9log arg type ${type}`);
  }
}

function parseDroppedPacket(
  header: On9logPacketHeader,
  payload: Uint8Array,
): On9logDroppedPacket {
  const reader = new Reader(payload);
  const droppedCount = reader.u32();
  return { header, kind: "dropped", droppedCount };
}

function parseTimeSyncPacket(
  header: On9logPacketHeader,
  payload: Uint8Array,
): On9logTimeSyncPacket {
  const reader = new Reader(payload);
  const bootTimeMs = reader.u32();
  const utcUnixMs = reader.u32();
  return { header, kind: "time_sync", bootTimeMs, utcUnixMs };
}

function parseBufferPacket(
  header: On9logPacketHeader,
  payload: Uint8Array,
): On9logBufferPacket {
  const reader = new Reader(payload);
  const totalLen = reader.u32();
  const offset = reader.u32();
  const chunkLen = reader.u32();
  const chunk = reader.bytes(chunkLen);
  return { header, kind: "buffer", totalLen, offset, chunk };
}

/** 16-bit sequence gap detection (modular arithmetic, handles wrap). */
export function sequenceGap(previous: number | null, current: number): number {
  if (previous === null) return 0;
  return (current - previous) & 0xffff;
}

/** 32-bit elapsed-time calculation (handles wrap after ~49.7 days). */
export function elapsedMs(previous: number, current: number): number {
  return (current - previous) >>> 0;
}
