/**
 * Log container protocol tests. All msgpack bytes are hand-built so the
 * suite stays self-contained and exercises the structural scanner directly.
 */

import { describe, expect, test } from "bun:test";
import {
  LOG_PACKET_MSG_MAGIC,
  LOG_PACKET_RAW_MAGIC,
  LogContainerError,
  MAX_BUNDLE_ELEMENTS,
  parseLogContainer,
} from "../../src/logging/container";

function bytes(...values: number[]): Uint8Array {
  return new Uint8Array(values);
}

/** bin8 element: 0xc4 + length + data. */
function bin8(data: Uint8Array): Uint8Array {
  return bytes(0xc4, data.length, ...data);
}

/** bin16 element: 0xc5 + 2-byte length + data. */
function bin16(data: Uint8Array): Uint8Array {
  return bytes(0xc5, (data.length >> 8) & 0xff, data.length & 0xff, ...data);
}

/** fixarray bundle (up to 15 elements). */
function fixBundle(elements: Uint8Array[]): Uint8Array {
  const flat = elements.flatMap((e) => [...e]);
  return bytes(0x90 + elements.length, ...flat);
}

/** array16 bundle (16-65535 elements). */
function array16Bundle(elements: Uint8Array[]): Uint8Array {
  const flat = elements.flatMap((e) => [...e]);
  return bytes(0xdc, (elements.length >> 8) & 0xff, elements.length & 0xff, ...flat);
}

/** Full /log payload: magic + bundle. */
function payload(bundle: Uint8Array): Uint8Array {
  return bytes(LOG_PACKET_MSG_MAGIC, ...bundle);
}

/** A plausible minimal on9log packet (18-byte header + 1-byte payload). */
function on9logPacket(seq: number): Uint8Array {
  const b = bytes(
    0x9a, // magic
    0x00, // type_level: LOG / NONE
    (seq >> 8) & 0xff,
    seq & 0xff, // seq
    0, 0, 0, 0, // time_ms
    0, 0, 0, 0, // tag_id
    0, 0, 0, 0, // fmt_id
    0x00, 0x00, // payload_len
    0x00, // payload: arg_count
  );
  return b;
}

function expectKind(
  kind: LogContainerError["kind"],
  fn: () => unknown,
): void {
  try {
    fn();
    expect.unreachable(`expected LogContainerError kind ${kind}`);
  } catch (error) {
    expect(error).toBeInstanceOf(LogContainerError);
    expect((error as LogContainerError).kind).toBe(kind);
  }
}

describe("parseLogContainer - raw mode (magic 0x9a)", () => {
  test("passes a raw single packet through unchanged", () => {
    const pkt = on9logPacket(1);
    const result = parseLogContainer(pkt);
    expect(result.dropped).toBe(0);
    expect(result.elements).toHaveLength(1);
    expect(result.elements[0]).toEqual(pkt);
  });

  test("raw mode does not validate on9log contents (ingest does that)", () => {
    const junk = bytes(LOG_PACKET_RAW_MAGIC, 0xde, 0xad, 0xbe, 0xef);
    const result = parseLogContainer(junk);
    expect(result.elements).toEqual([junk]);
  });
});

describe("parseLogContainer - magic dispatch", () => {
  test("empty payload has no magic", () => {
    expectKind("invalid_magic", () => parseLogContainer(bytes()));
  });

  test("unknown magic is rejected and reserved for future types", () => {
    expectKind("invalid_magic", () => parseLogContainer(bytes(0x02, 0x90)));
    expectKind("invalid_magic", () => parseLogContainer(bytes(0xff, 0x90)));
  });
});

describe("parseLogContainer - msgpack bundle mode (magic 0x01)", () => {
  test("single element bundle", () => {
    const pkt = on9logPacket(7);
    const result = parseLogContainer(payload(fixBundle([bin8(pkt)])));
    expect(result.dropped).toBe(0);
    expect(result.elements).toEqual([pkt]);
  });

  test("multiple elements of different lengths (fixarray)", () => {
    const a = on9logPacket(1);
    const b = bytes(0x9a, 1, 2, 3);
    const c = on9logPacket(2);
    const result = parseLogContainer(payload(fixBundle([bin8(a), bin8(b), bin8(c)])));
    expect(result.dropped).toBe(0);
    expect(result.elements).toEqual([a, b, c]);
  });

  test("array16 bundle (more than 15 elements)", () => {
    const pkts = Array.from({ length: 20 }, (_, i) => on9logPacket(i));
    const result = parseLogContainer(payload(array16Bundle(pkts.map(bin8))));
    expect(result.dropped).toBe(0);
    expect(result.elements).toHaveLength(20);
    expect(result.elements[19]).toEqual(on9logPacket(19));
  });

  test("bin16 elements are accepted", () => {
    const big = bytes(0x9a, ...Array.from({ length: 300 }, (_, i) => i & 0xff));
    const result = parseLogContainer(payload(fixBundle([bin16(big)])));
    expect(result.elements).toEqual([big]);
  });

  test("non-bin elements are skipped and counted", () => {
    const pkt = on9logPacket(3);
    const result = parseLogContainer(
      payload(fixBundle([bin8(pkt), bytes(0x01), bytes(0xa2, 0x78, 0x79)])),
    );
    expect(result.dropped).toBe(2); // fixint 1, fixstr "xy"
    expect(result.elements).toEqual([pkt]);
  });

  test("nested array element is skipped as a whole value", () => {
    const pkt = on9logPacket(4);
    // element: fixarray [1, 2] -> 0x92 0x01 0x02
    const result = parseLogContainer(
      payload(fixBundle([bin8(pkt), bytes(0x92, 0x01, 0x02)])),
    );
    expect(result.dropped).toBe(1);
    expect(result.elements).toEqual([pkt]);
  });

  test("ext element is skipped as a whole value", () => {
    const pkt = on9logPacket(5);
    // fixext1: 0xd4 0x01 (type) 0x2a (data)
    const result = parseLogContainer(
      payload(fixBundle([bin8(pkt), bytes(0xd4, 0x01, 0x2a)])),
    );
    expect(result.dropped).toBe(1);
    expect(result.elements).toEqual([pkt]);
  });

  test("empty bin element is skipped", () => {
    const result = parseLogContainer(payload(fixBundle([bin8(bytes())])));
    expect(result.dropped).toBe(1);
    expect(result.elements).toEqual([]);
  });

  test("mixed well-formed and malformed elements", () => {
    const a = on9logPacket(1);
    const b = on9logPacket(2);
    const result = parseLogContainer(
      payload(fixBundle([bin8(a), bytes(0x01), bin8(bytes()), bin8(b)])),
    );
    expect(result.dropped).toBe(2);
    expect(result.elements).toEqual([a, b]);
  });

  test("bin32 elements are outside the contract and are skipped", () => {
    // 0xc6 0x00 0x00 0x00 0x01 0x2a : bin32 with length 1, payload 0x2a
    const result = parseLogContainer(payload(fixBundle([bytes(0xc6, 0, 0, 0, 1, 0x2a)])));
    expect(result.dropped).toBe(1);
    expect(result.elements).toEqual([]);
  });

  test("empty bundle (zero elements) is rejected", () => {
    expectKind("invalid_msgpack", () => parseLogContainer(payload(bytes(0x90))));
    expectKind("invalid_msgpack", () => parseLogContainer(payload(bytes(0xdc, 0, 0))));
  });

  test("root must be an array", () => {
    expectKind("invalid_msgpack", () => parseLogContainer(payload(bytes(0xc4, 0x01, 0x2a)))); // bin root
    expectKind("invalid_msgpack", () => parseLogContainer(payload(bytes(0x01)))); // int root
    expectKind("invalid_msgpack", () => parseLogContainer(payload(bytes(0xc0)))); // nil root
  });

  test("declared element count beyond the limit is rejected without allocating", () => {
    // array16 declaring 65535 elements (only the 3-byte header is present)
    expectKind("too_many_elements", () => parseLogContainer(payload(bytes(0xdc, 0xff, 0xff))));
    // array32 declaring 0xffffffff elements
    expectKind("too_many_elements", () =>
      parseLogContainer(payload(bytes(0xdd, 0xff, 0xff, 0xff, 0xff))),
    );
  });

  test("truncated bundle is rejected", () => {
    // bin8 declares 5 bytes but only 1 is present
    expectKind("invalid_msgpack", () => parseLogContainer(payload(bytes(0x91, 0xc4, 0x05, 0x01))));
    // array16 header truncated
    expectKind("invalid_msgpack", () => parseLogContainer(payload(bytes(0xdc, 0x01))));
    // element type byte missing
    expectKind("invalid_msgpack", () => parseLogContainer(payload(bytes(0x91))));
  });

  test("trailing bytes after the array are rejected", () => {
    expectKind("invalid_msgpack", () =>
      parseLogContainer(payload(bytes(0x91, 0xc4, 0x01, 0x2a, 0x00))),
    );
  });

  test("truncated skipped element is rejected (not silently dropped)", () => {
    // element is a fixarray declaring 2 items but only 1 byte follows
    expectKind("invalid_msgpack", () =>
      parseLogContainer(payload(bytes(0x91, 0x92, 0x01))),
    );
  });

  test("MAX_BUNDLE_ELEMENTS is exported and sane", () => {
    expect(MAX_BUNDLE_ELEMENTS).toBe(4096);
  });
});
