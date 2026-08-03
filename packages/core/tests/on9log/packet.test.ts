import { describe, expect, test } from "bun:test";
import {
  On9logArgType,
  On9logPacketType,
  parseOn9logPacket,
  sequenceGap,
  elapsedMs,
} from "../../src/on9log/packet";

describe("parseOn9logPacket", () => {
  test("parses a LOG packet with 32-bit args (hand-built)", () => {
    // header: magic 9a, type_level 03 (LOG/INFO), seq 0, time 0x11223344,
    // tag_id 0x00418008, fmt_id 0x004192e0, payload_len 7
    // payload: arg_count 2, types [1,1], args 5, 6
    const bytes = new Uint8Array([
      0x9a, 0x03, 0x00, 0x00, 0x44, 0x33, 0x22, 0x11, 0x08, 0x80, 0x41, 0x00,
      0xe0, 0x92, 0x41, 0x00, 0x0b, 0x00, // header (payload_len 11)
      0x02, 0x01, 0x01, // count + types
      0x05, 0x00, 0x00, 0x00, 0x06, 0x00, 0x00, 0x00, // args
    ]);
    const packet = parseOn9logPacket(bytes);
    expect(packet.kind).toBe("log");
    if (packet.kind !== "log") return;
    expect(packet.header.type).toBe(On9logPacketType.Log);
    expect(packet.header.level).toBe(3);
    expect(packet.header.seq).toBe(0);
    expect(packet.header.timeMs).toBe(0x11223344);
    expect(packet.header.tagId).toBe(0x00418008);
    expect(packet.header.fmtId).toBe(0x004192e0);
    expect(packet.argCount).toBe(2);
    expect(packet.args).toEqual([
      { type: On9logArgType.Bits32, value: 5 },
      { type: On9logArgType.Bits32, value: 6 },
    ]);
  });

  test("parses a LOG packet with a dynamic string", () => {
    // args: one dynamic string "Linux"
    const bytes = new Uint8Array([
      0x9a, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00, 0x0b, 0x00, // header, payload_len 11
      0x01, 0x04, // count 1, type DYNAMIC_STRING
      0x05, 0x00, 0x00, 0x00, 0x4c, 0x69, 0x6e, 0x75, 0x78, // len 5 + "Linux"
    ]);
    const packet = parseOn9logPacket(bytes);
    expect(packet.kind).toBe("log");
    if (packet.kind !== "log") return;
    expect(packet.args).toEqual([
      { type: On9logArgType.DynamicString, value: new TextEncoder().encode("Linux") },
    ]);
  });

  test("parses a null dynamic string", () => {
    const bytes = new Uint8Array([
      0x9a, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00, 0x06, 0x00, // payload_len 6
      0x01, 0x04, // count 1, DYNAMIC_STRING
      0xff, 0xff, 0xff, 0xff, // len 0xffffffff = null
    ]);
    const packet = parseOn9logPacket(bytes);
    expect(packet.kind).toBe("log");
    if (packet.kind !== "log") return;
    expect(packet.args).toEqual([
      { type: On9logArgType.DynamicString, value: null },
    ]);
  });

  test("parses DROPPED, TIME_SYNC and BUFFER packets", () => {
    const dropped = parseOn9logPacket(
      new Uint8Array([
        0x9a, 0x11, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x04, 0x00, 0x2a, 0x00, 0x00, 0x00,
      ]),
    );
    expect(dropped.kind).toBe("dropped");
    if (dropped.kind === "dropped") {
      expect(dropped.header.type).toBe(On9logPacketType.Dropped);
      expect(dropped.droppedCount).toBe(42);
    }

    const ts = parseOn9logPacket(
      new Uint8Array([
        0x9a, 0x20, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x08, 0x00, 0x01, 0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00,
      ]),
    );
    expect(ts.kind).toBe("time_sync");
    if (ts.kind === "time_sync") {
      expect(ts.bootTimeMs).toBe(1);
      expect(ts.utcUnixMs).toBe(2);
    }

    const buffer = parseOn9logPacket(
      new Uint8Array([
        0x9a, 0x40, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x11, 0x00, // payload_len 17
        0x05, 0x00, 0x00, 0x00, // total_len 5
        0x00, 0x00, 0x00, 0x00, // offset 0
        0x05, 0x00, 0x00, 0x00, // chunk_len 5
        0x01, 0x02, 0x03, 0x04, 0x05, // bytes
      ]),
    );
    expect(buffer.kind).toBe("buffer");
    if (buffer.kind === "buffer") {
      expect(buffer.totalLen).toBe(5);
      expect(buffer.offset).toBe(0);
      expect(buffer.chunk).toEqual(new Uint8Array([1, 2, 3, 4, 5]));
    }
  });

  test("rejects bad magic, truncation and unknown types", () => {
    expect(() => parseOn9logPacket(new Uint8Array(18).fill(0))).toThrow();
    expect(() => parseOn9logPacket(new Uint8Array([0x9a, 0x03]))).toThrow();
    // type 15 (0xf0) is unknown
    expect(() =>
      parseOn9logPacket(
        new Uint8Array([
          0x9a, 0xf0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
          0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        ]),
      ),
    ).toThrow(/unknown on9log packet type/);
    // payload shorter than arg table
    expect(() =>
      parseOn9logPacket(
        new Uint8Array([
          0x9a, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
          0x00, 0x00, 0x00, 0x00, 0x02, 0x00, 0x05, 0x01,
        ]),
      ),
    ).toThrow();
  });

  test("accepts streaming payloads (payload_len 0xffff)", () => {
    const bytes = new Uint8Array([
      0x9a, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00, 0xff, 0xff, // streaming
      0x01, 0x01, 0x07, 0x00, 0x00, 0x00, // count 1, type 32BITS, arg 7
    ]);
    const packet = parseOn9logPacket(bytes);
    expect(packet.kind).toBe("log");
    if (packet.kind === "log") {
      expect(packet.args).toEqual([{ type: On9logArgType.Bits32, value: 7 }]);
    }
  });
});

describe("sequence/timestamp wrap helpers", () => {
  test("sequenceGap handles wrap", () => {
    expect(sequenceGap(null, 42)).toBe(0);
    expect(sequenceGap(41, 42)).toBe(1);
    expect(sequenceGap(65535, 0)).toBe(1);
    expect(sequenceGap(65530, 5)).toBe(11);
    expect(sequenceGap(5, 65530)).toBe(65525); // big gap = lost packets
  });

  test("elapsedMs handles 32-bit wrap", () => {
    expect(elapsedMs(1000, 2000)).toBe(1000);
    expect(elapsedMs(0xfffffff0, 0x10)).toBe(32);
  });
});

describe("arg type coverage", () => {
  function logPacket(argCount: number, argTypes: number[], payload: number[]): Uint8Array {
    return new Uint8Array([
      0x9a, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00, 0xff, 0xff, // streaming header
      argCount, ...argTypes, ...payload,
    ]);
  }

  test("64-bit argument", () => {
    const p = parseOn9logPacket(logPacket(1, [2], [0x78, 0x56, 0x34, 0x12, 0xef, 0xcd, 0xab, 0x90]));
    expect(p.kind).toBe("log");
    if (p.kind === "log") {
      expect(p.args).toEqual([{ type: On9logArgType.Bits64, value: 0x90abcdef12345678n }]);
    }
  });

  test("pointer argument", () => {
    const p = parseOn9logPacket(logPacket(1, [3], [0x34, 0xc4, 0x53, 0xb6]));
    expect(p.kind).toBe("log");
    if (p.kind === "log") {
      expect(p.args).toEqual([{ type: On9logArgType.Pointer, value: 0xb653c434 }]);
    }
  });

  test("dynamic string view argument", () => {
    const p = parseOn9logPacket(logPacket(1, [5], [0x02, 0x00, 0x00, 0x00, 0x61, 0x62]));
    expect(p.kind).toBe("log");
    if (p.kind === "log") {
      expect(p.args).toEqual([
        { type: On9logArgType.DynamicStringView, value: new TextEncoder().encode("ab") },
      ]);
    }
  });

  test("zero-argument log (arg_count 0)", () => {
    const p = parseOn9logPacket(logPacket(0, [], []));
    expect(p.kind).toBe("log");
    if (p.kind === "log") {
      expect(p.argCount).toBe(0);
      expect(p.args).toEqual([]);
    }
  });

  test("mixed argument types in one packet", () => {
    const p = parseOn9logPacket(
      logPacket(4, [1, 2, 4, 3], [
        0x05, 0x00, 0x00, 0x00, // 32-bit: 5
        0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // 64-bit: 8
        0x02, 0x00, 0x00, 0x00, 0x78, 0x79, // string "xy"
        0xaa, 0x00, 0x00, 0x00, // pointer
      ]),
    );
    expect(p.kind).toBe("log");
    if (p.kind === "log") {
      expect(p.args).toEqual([
        { type: On9logArgType.Bits32, value: 5 },
        { type: On9logArgType.Bits64, value: 8n },
        { type: On9logArgType.DynamicString, value: new TextEncoder().encode("xy") },
        { type: On9logArgType.Pointer, value: 0xaa },
      ]);
    }
  });

  test("non-streaming packet with trailing bytes is rejected", () => {
    // header payload_len = 2 but payload has 3 bytes
    const p = new Uint8Array([
      0x9a, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00, 0x02, 0x00, // payload_len 2
      0x01, 0x01, 0x05, 0x00, 0x00, 0x00, // count, type, arg (3 payload bytes)
    ]);
    expect(() => parseOn9logPacket(p)).toThrow(/does not match declared payload length/);
  });

  test("truncated 64-bit argument is rejected", () => {
    const p = logPacket(1, [2], [0x00, 0x00, 0x00, 0x00]); // only 4 of 8 bytes
    expect(() => parseOn9logPacket(p)).toThrow(/truncated/);
  });

  test("truncated dynamic string is rejected", () => {
    const p = logPacket(1, [4], [0x05, 0x00, 0x00, 0x00, 0x61]); // len 5, 1 byte
    expect(() => parseOn9logPacket(p)).toThrow(/truncated/);
  });

  test("unknown arg type is rejected", () => {
    const p = logPacket(1, [9], [0x00]);
    expect(() => parseOn9logPacket(p)).toThrow(/unknown on9log arg type/);
  });

  test("BUFFER packet with truncated chunk is rejected", () => {
    const p = new Uint8Array([
      0x9a, 0x40, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00, 0x0d, 0x00, // payload_len 13
      0x05, 0x00, 0x00, 0x00, // total 5
      0x00, 0x00, 0x00, 0x00, // offset 0
      0x05, 0x00, 0x00, 0x00, // chunk_len 5
      0x01, // only 1 byte
    ]);
    expect(() => parseOn9logPacket(p)).toThrow(/truncated/);
  });
});
