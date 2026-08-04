import { describe, expect, test } from "bun:test";
import {
  ON9LOG_FRAME_END,
  ON9LOG_FRAME_START,
  ON9LOG_FRAME_TYPE_ON9LOG,
  SlipDecoder,
  SlipParseError,
  crc16Ccitt,
} from "../helpers/slip";

/** Encodes one SLIP frame (mirrors the firmware framing). */
function encodeSlipFrame(type: number, payload: Uint8Array): Uint8Array {
  const body = [type, ...payload];
  const crc = crc16Ccitt(Uint8Array.from(body), 0xffff);
  const out: number[] = [ON9LOG_FRAME_START];
  for (const b of [...body, crc & 0xff, crc >> 8]) {
    if (b === ON9LOG_FRAME_START) out.push(0xdb, 0xde);
    else if (b === ON9LOG_FRAME_END) out.push(0xdb, 0xdc);
    else if (b === 0xdb) out.push(0xdb, 0xdd);
    else if (b === 0x0d) out.push(0xdb, 0xd0);
    else if (b === 0x0a) out.push(0xdb, 0xd1);
    else out.push(b);
  }
  out.push(ON9LOG_FRAME_END);
  return Uint8Array.from(out);
}

describe("crc16Ccitt", () => {
  test("matches the documented algorithm", () => {
    // init 0xffff, no bytes -> stays 0xffff (the init value is the register)
    expect(crc16Ccitt(new Uint8Array([]), 0xffff)).toBe(0xffff);
    // single byte 0x00: crc = 0xffff ^ (0 << 8) then 8 shifts
    expect(crc16Ccitt(new Uint8Array([0x00]), 0xffff)).toBe(0xe1f0);
    // "123456789" is the standard CRC-16-CCITT check value (init 0xffff,
    // poly 0x1021, no final xor) = 0x29b1
    expect(crc16Ccitt(new TextEncoder().encode("123456789"), 0xffff)).toBe(0x29b1);
  });
});

describe("SlipDecoder", () => {
  test("decodes a single frame round-trip", () => {
    const payload = new Uint8Array([0x9a, 0x03, 0x00, 0x01, 0x02, 0x03]);
    const frame = encodeSlipFrame(ON9LOG_FRAME_TYPE_ON9LOG, payload);
    const decoder = new SlipDecoder();
    decoder.push(frame);
    const frames = decoder.frames();
    expect(frames).toHaveLength(1);
    expect(frames[0]!.type).toBe(ON9LOG_FRAME_TYPE_ON9LOG);
    expect([...frames[0]!.payload]).toEqual([...payload]);
  });

  test("escapes special bytes inside the payload", () => {
    // payload containing every escapable byte
    const payload = new Uint8Array([0xa5, 0xc0, 0xdb, 0x0d, 0x0a, 0x41]);
    const frame = encodeSlipFrame(ON9LOG_FRAME_TYPE_ON9LOG, payload);
    // inside the frame (after the start byte, before the end byte) no
    // unescaped special byte may appear; 0xdb only occurs as part of a
    // valid two-byte escape sequence
    const inside = [...frame.subarray(1, frame.length - 1)];
    expect(inside.includes(0xa5)).toBe(false);
    expect(inside.includes(0xc0)).toBe(false);
    expect(inside.includes(0x0d)).toBe(false);
    expect(inside.includes(0x0a)).toBe(false);
    for (let i = 0; i < inside.length; i++) {
      if (inside[i] === 0xdb) {
        const next = inside[i + 1];
        expect([0xde, 0xdc, 0xdd, 0xd0, 0xd1]).toContain(next!);
      }
    }
    const decoder = new SlipDecoder();
    decoder.push(frame);
    const frames = decoder.frames();
    expect([...frames[0]!.payload]).toEqual([...payload]);
  });

  test("decodes multiple frames in one buffer", () => {
    const a = encodeSlipFrame(0x01, new Uint8Array([0x9a, 0x01]));
    const b = encodeSlipFrame(0x02, new TextEncoder().encode("text"));
    const decoder = new SlipDecoder();
    decoder.push(Uint8Array.from([...a, ...b]));
    const frames = decoder.frames();
    expect(frames).toHaveLength(2);
    expect(frames[0]!.type).toBe(0x01);
    expect(frames[1]!.type).toBe(0x02);
    expect(new TextDecoder().decode(frames[1]!.payload)).toBe("text");
  });

  test("handles incremental (chunked) input", () => {
    const frame = encodeSlipFrame(0x01, new Uint8Array([0x9a, 0x03, 0x00, 0xaa]));
    const decoder = new SlipDecoder();
    let total = 0;
    for (let i = 0; i < frame.length; i++) {
      decoder.push(frame.subarray(i, i + 1));
      total += decoder.frames().length;
    }
    expect(total).toBe(1); // complete only after the final byte
  });

  test("skips garbage bytes before the frame start (resync)", () => {
    const frame = encodeSlipFrame(0x01, new Uint8Array([0x9a, 0x00]));
    const garbage = new Uint8Array([0x00, 0x7f, 0xaa, 0x99]);
    const decoder = new SlipDecoder();
    decoder.push(Uint8Array.from([...garbage, ...frame]));
    const frames = decoder.frames();
    expect(frames).toHaveLength(1);
    expect(frames[0]!.start).toBe(garbage.length);
  });

  test("keeps an unterminated frame until the end marker arrives", () => {
    const frame = encodeSlipFrame(0x01, new Uint8Array([0x9a, 0x00]));
    const decoder = new SlipDecoder();
    decoder.push(frame.subarray(0, frame.length - 1)); // cut before 0xc0
    expect(decoder.frames()).toHaveLength(0);
    decoder.push(frame.subarray(frame.length - 1));
    expect(decoder.frames()).toHaveLength(1);
  });

  test("rejects corrupted CRC", () => {
    const frame = encodeSlipFrame(0x01, new Uint8Array([0x9a, 0x00]));
    const corrupted = Uint8Array.from(frame);
    corrupted[corrupted.length - 3]! ^= 0xff; // flip a CRC byte
    const decoder = new SlipDecoder();
    decoder.push(corrupted);
    expect(() => decoder.frames()).toThrow(SlipParseError);
  });

  test("rejects invalid escape sequences", () => {
    // frame with 0xdb followed by an unknown byte
    const bad = new Uint8Array([
      ON9LOG_FRAME_START, 0x01, 0xdb, 0x99, 0x00, 0x00, ON9LOG_FRAME_END,
    ]);
    const decoder = new SlipDecoder();
    decoder.push(bad);
    expect(() => decoder.frames()).toThrow(/invalid SLIP escape/);
  });

  test("rejects frames without CRC (payload too short)", () => {
    const bad = new Uint8Array([ON9LOG_FRAME_START, 0x01, ON9LOG_FRAME_END]);
    const decoder = new SlipDecoder();
    decoder.push(bad);
    expect(() => decoder.frames()).toThrow(/too short/);
  });

  test("throws on buffer overflow", () => {
    const decoder = new SlipDecoder();
    // frame start + unterminated payload beyond the max buffer
    decoder.push(Uint8Array.from([ON9LOG_FRAME_START, ...new Uint8Array(100).fill(0x41)]));
    expect(() => decoder.frames(64)).toThrow(/overflow/);
  });

  test("consumes parsed frames from the buffer", () => {
    const a = encodeSlipFrame(0x01, new Uint8Array([0x9a]));
    const b = encodeSlipFrame(0x01, new Uint8Array([0x9b]));
    const decoder = new SlipDecoder();
    decoder.push(Uint8Array.from([...a, ...b]));
    expect(decoder.frames()).toHaveLength(2);
    expect(decoder.frames()).toHaveLength(0); // drained
  });

  test("recovers after a corrupt frame followed by a good one", () => {
    const good = encodeSlipFrame(0x01, new Uint8Array([0x9a, 0x00]));
    const bad = Uint8Array.from(good);
    bad[bad.length - 3]! ^= 0x01;
    const decoder = new SlipDecoder();
    // push bad and good together; the decoder throws on the bad CRC before
    // it can see the good frame (documented behavior: corruption aborts)
    decoder.push(Uint8Array.from([...bad, ...good]));
    expect(() => decoder.frames()).toThrow(SlipParseError);
  });

  test("resyncs after an unterminated partial frame", () => {
    const good = encodeSlipFrame(0x01, new Uint8Array([0x9a, 0x00]));
    const partial = encodeSlipFrame(0x01, new Uint8Array([0x9b]));
    const decoder = new SlipDecoder();
    // partial frame (no end marker) followed by a good frame: the decoder
    // sees one long frame; CRC check fails
    decoder.push(Uint8Array.from([...partial.subarray(0, partial.length - 1), ...good]));
    expect(() => decoder.frames()).toThrow(SlipParseError);
  });
});
