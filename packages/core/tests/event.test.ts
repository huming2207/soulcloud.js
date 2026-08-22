import { describe, expect, test } from "bun:test";
import { encode as msgpackEncode } from "@msgpack/msgpack";
import {
  decodeDeviceEvent,
  DeviceEventPayloadError,
  encodeDeviceEvent,
} from "../src/protocol/event";

const id = Uint8Array.from({ length: 16 }, (_, index) => index);

describe("device event codec", () => {
  test("round-trips the fixed envelope", () => {
    const encoded = encodeDeviceEvent({
      id,
      seq: 42n,
      kind: "fixture.result",
      schema: 1,
      data: { passed: true, attempt: 2 },
    });
    expect(decodeDeviceEvent(encoded)).toEqual({
      id,
      seq: 42n,
      kind: "fixture.result",
      schema: 1,
      data: { passed: true, attempt: 2 },
    });
  });

  test("rejects duplicate, unknown and trailing fields", () => {
    const duplicate = Uint8Array.from([
      0x86,
      0xa2,
      0x69,
      0x64,
      0xc4,
      0x10,
      ...id,
      0xa3,
      0x73,
      0x65,
      0x71,
      0x01,
      0xa4,
      0x6b,
      0x69,
      0x6e,
      0x64,
      0xa1,
      0x78,
      0xa6,
      0x73,
      0x63,
      0x68,
      0x65,
      0x6d,
      0x61,
      0x01,
      0xa4,
      0x64,
      0x61,
      0x74,
      0x61,
      0xc0,
      0xa2,
      0x69,
      0x64,
      0xc4,
      0x10,
      ...id,
    ]);
    expect(() => decodeDeviceEvent(duplicate)).toThrow(DeviceEventPayloadError);
    expect(() => decodeDeviceEvent(msgpackEncode({ id, seq: 1, kind: "x", schema: 1, data: null, extra: true }))).toThrow(
      DeviceEventPayloadError,
    );
    expect(() => decodeDeviceEvent(Uint8Array.from([...encodeDeviceEvent({ id, seq: 1n, kind: "x", schema: 1, data: null }), 0xc0]))).toThrow(
      DeviceEventPayloadError,
    );
  });

  test("requires a 16-byte id and positive schema", () => {
    expect(() =>
      decodeDeviceEvent(msgpackEncode({ id: Uint8Array.of(1), seq: 1, kind: "x", schema: 1, data: null })),
    ).toThrow(DeviceEventPayloadError);
    expect(() =>
      decodeDeviceEvent(msgpackEncode({ id, seq: 1, kind: "x", schema: 0, data: null })),
    ).toThrow(DeviceEventPayloadError);
  });
});
