/**
 * Lightweight MessagePack structural validator.
 *
 * JS MessagePack decoders (@msgpack/msgpack, msgpackr) silently overwrite
 * duplicate map keys, so the strict Soulcloud wire contract ("reject
 * duplicate fields") cannot be enforced by decoding alone. This module walks
 * the raw MessagePack tokens without building objects and rejects:
 *
 *   - trailing bytes after the one complete value
 *   - duplicate map keys (at any depth)
 *   - malformed / truncated payloads
 *
 * It is intentionally minimal (type-walking only). Field-level validation is
 * done by the Zod schemas in command.ts / stat.ts.
 */

export class MessagePackStructureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MessagePackStructureError";
  }
}

/** A MessagePack map key seen so far in the current map. */
interface MapKeyState {
  /** Keys seen in the current map, to detect duplicates. */
  keys: Set<string>;
  /** Parent state, or null for the top-level map. */
  parent: MapKeyState | null;
}

const enum Type {
  Nil = 0xc0,
  False = 0xc2,
  True = 0xc3,
  Bin8 = 0xc4,
  Bin16 = 0xc5,
  Bin32 = 0xc6,
  Ext8 = 0xc7,
  Ext16 = 0xc8,
  Ext32 = 0xc9,
  Float32 = 0xca,
  Float64 = 0xcb,
  Uint8 = 0xcc,
  Uint16 = 0xcd,
  Uint32 = 0xce,
  Uint64 = 0xcf,
  Int8 = 0xd0,
  Int16 = 0xd1,
  Int32 = 0xd2,
  Int64 = 0xd3,
  FixExt1 = 0xd4,
  FixExt2 = 0xd5,
  FixExt4 = 0xd6,
  FixExt8 = 0xd7,
  FixExt16 = 0xd8,
  Str8 = 0xd9,
  Str16 = 0xda,
  Str32 = 0xdb,
  Array16 = 0xdc,
  Array32 = 0xdd,
  Map16 = 0xde,
  Map32 = 0xdf,
}

class Reader {
  constructor(private readonly buf: Uint8Array, public pos = 0) {}

  take(n: number): Uint8Array {
    if (this.pos + n > this.buf.length) {
      throw new MessagePackStructureError(
        `truncated MessagePack payload: need ${n} bytes at offset ${this.pos}, have ${this.buf.length - this.pos}`,
      );
    }
    const out = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }

  byte(): number {
    return this.take(1)[0]!;
  }
}

/**
 * Validates that `payload` is exactly one well-formed MessagePack value with
 * no trailing bytes and no duplicate map keys.
 *
 * @throws {MessagePackStructureError} on any violation.
 */
export function validateMessagePackStructure(payload: Uint8Array): void {
  const reader = new Reader(payload);
  walkValue(reader, null);
  if (reader.pos !== payload.length) {
    throw new MessagePackStructureError(
      `MessagePack payload contains ${payload.length - reader.pos} trailing bytes`,
    );
  }
}

function walkValue(reader: Reader, mapState: MapKeyState | null): void {
  const marker = reader.byte();

  if (marker <= 0x7f || marker >= 0xe0) {
    return; // positive fixint / negative fixint
  }
  switch (marker) {
    case Type.Nil:
    case Type.False:
    case Type.True:
      return;
    case 0x80:
    case 0x81:
    case 0x82:
    case 0x83:
    case 0x84:
    case 0x85:
    case 0x86:
    case 0x87:
    case 0x88:
    case 0x89:
    case 0x8a:
    case 0x8b:
    case 0x8c:
    case 0x8d:
    case 0x8e:
    case 0x8f:
      walkMap(reader, marker & 0x0f, mapState);
      return;
    case 0x90:
    case 0x91:
    case 0x92:
    case 0x93:
    case 0x94:
    case 0x95:
    case 0x96:
    case 0x97:
    case 0x98:
    case 0x99:
    case 0x9a:
    case 0x9b:
    case 0x9c:
    case 0x9d:
    case 0x9e:
    case 0x9f:
      walkArray(reader, marker & 0x0f, mapState);
      return;
    case 0xa0:
    case 0xa1:
    case 0xa2:
    case 0xa3:
    case 0xa4:
    case 0xa5:
    case 0xa6:
    case 0xa7:
    case 0xa8:
    case 0xa9:
    case 0xaa:
    case 0xab:
    case 0xac:
    case 0xad:
    case 0xae:
    case 0xaf:
    case 0xb0:
    case 0xb1:
    case 0xb2:
    case 0xb3:
    case 0xb4:
    case 0xb5:
    case 0xb6:
    case 0xb7:
    case 0xb8:
    case 0xb9:
    case 0xba:
    case 0xbb:
    case 0xbc:
    case 0xbd:
    case 0xbe:
    case 0xbf:
      reader.take(marker & 0x1f);
      return;
    case Type.Str8:
      reader.take(readU8(reader));
      return;
    case Type.Str16:
      reader.take(readU16(reader));
      return;
    case Type.Str32:
      reader.take(readU32(reader));
      return;
    case Type.Bin8:
      reader.take(readU8(reader));
      return;
    case Type.Bin16:
      reader.take(readU16(reader));
      return;
    case Type.Bin32:
      reader.take(readU32(reader));
      return;
    case Type.Float32:
    case Type.Uint32:
    case Type.Int32:
      reader.take(4);
      return;
    case Type.Float64:
    case Type.Uint64:
    case Type.Int64:
      reader.take(8);
      return;
    case Type.Uint8:
    case Type.Int8:
      reader.take(1);
      return;
    case Type.Uint16:
    case Type.Int16:
      reader.take(2);
      return;
    case Type.FixExt1:
      reader.take(2);
      return;
    case Type.FixExt2:
      reader.take(3);
      return;
    case Type.FixExt4:
      reader.take(5);
      return;
    case Type.FixExt8:
      reader.take(9);
      return;
    case Type.FixExt16:
      reader.take(17);
      return;
    case Type.Ext8:
      reader.take(readU8(reader) + 1);
      return;
    case Type.Ext16:
      reader.take(readU16(reader) + 1);
      return;
    case Type.Ext32:
      reader.take(readU32(reader) + 1);
      return;
    case Type.Array16:
      walkArray(reader, readU16(reader), mapState);
      return;
    case Type.Array32:
      walkArray(reader, readU32(reader), mapState);
      return;
    case Type.Map16:
      walkMap(reader, readU16(reader), mapState);
      return;
    case Type.Map32:
      walkMap(reader, readU32(reader), mapState);
      return;
    default:
      throw new MessagePackStructureError(
        `invalid MessagePack marker byte 0x${marker.toString(16)} at offset ${reader.pos - 1}`,
      );
  }
}

function walkArray(reader: Reader, length: number, mapState: MapKeyState | null): void {
  for (let i = 0; i < length; i++) {
    walkValue(reader, mapState);
  }
}

function walkMap(reader: Reader, length: number, parent: MapKeyState | null): void {
  const state: MapKeyState = { keys: new Set(), parent };
  for (let i = 0; i < length; i++) {
    const keyStart = reader.pos;
    walkValue(reader, state);
    const key = decodeStringKey(reader.buf, keyStart, reader.pos);
    if (state.keys.has(key)) {
      throw new MessagePackStructureError(
        `duplicate map key ${JSON.stringify(key)} in MessagePack payload`,
      );
    }
    state.keys.add(key);
    walkValue(reader, state);
  }
}

/**
 * Decodes the raw bytes of a map key as a string. Map keys in the Soulcloud
 * wire contract are always strings; any other key type is a structural error.
 */
function decodeStringKey(buf: Uint8Array, start: number, end: number): string {
  if (start >= end) {
    throw new MessagePackStructureError("empty map key in MessagePack payload");
  }
  const marker = buf[start]!;
  let strStart: number;
  let strLen: number;
  if (marker >= 0xa0 && marker <= 0xbf) {
    strStart = start + 1;
    strLen = marker & 0x1f;
  } else if (marker === Type.Str8) {
    strStart = start + 2;
    strLen = buf[start + 1]!;
  } else if (marker === Type.Str16) {
    strStart = start + 3;
    strLen = ((buf[start + 1]! << 8) | buf[start + 2]!) as number;
  } else if (marker === Type.Str32) {
    strStart = start + 5;
    strLen = ((buf[start + 1]! << 24) | (buf[start + 2]! << 16) | (buf[start + 3]! << 8) | buf[start + 4]!) >>> 0;
  } else {
    throw new MessagePackStructureError(
      `MessagePack map key is not a string (marker 0x${marker.toString(16)})`,
    );
  }
  if (strStart + strLen !== end) {
    throw new MessagePackStructureError("malformed MessagePack map key");
  }
  return new TextDecoder().decode(buf.subarray(strStart, strStart + strLen));
}

function readU8(reader: Reader): number {
  return reader.byte();
}

function readU16(reader: Reader): number {
  const b = reader.take(2);
  return (b[0]! << 8) | b[1]!;
}

function readU32(reader: Reader): number {
  const b = reader.take(4);
  return ((b[0]! << 24) | (b[1]! << 16) | (b[2]! << 8) | b[3]!) >>> 0;
}
