import { describe, expect, test } from "bun:test";
import {
  DeviceStatPayloadError,
  decodeDeviceStat,
  encodeDeviceStat,
} from "../src/protocol/stat";

describe("device stat codec", () => {
  test("decodes and encodes the documented status shape", () => {
    // {sn: bin[1,2,3], fw: bin[0xaa,0xbb], up: 4294967296, rst: "watch"}
    const payload = new Uint8Array([
      0x84, 0xa2, 0x73, 0x6e, 0xc4, 0x03, 0x01, 0x02, 0x03, 0xa2, 0x66, 0x77, 0xc4,
      0x02, 0xaa, 0xbb, 0xa2, 0x75, 0x70, 0xcf, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00,
      0x00, 0x00, 0xa3, 0x72, 0x73, 0x74, 0xa5, 0x77, 0x61, 0x74, 0x63, 0x68,
    ]);
    const stat = {
      sn: new Uint8Array([1, 2, 3]),
      fw: new Uint8Array([0xaa, 0xbb]),
      up: 4294967296n,
      rst: "watch",
    };
    expect(decodeDeviceStat(payload)).toEqual(stat);
    expect(encodeDeviceStat(stat)).toEqual(payload);
  });

  test("rejects missing, unknown or wrongly typed fields", () => {
    // missing rst: {sn: bin[], fw: bin[], up: 0}
    const missingRst = new Uint8Array([
      0x83, 0xa2, 0x73, 0x6e, 0xc4, 0x00, 0xa2, 0x66, 0x77, 0xc4, 0x00, 0xa2, 0x75,
      0x70, 0x00,
    ]);
    // unknown field: {sn, fw, up, rst, extra: nil}
    const unknownField = new Uint8Array([
      0x85, 0xa2, 0x73, 0x6e, 0xc4, 0x00, 0xa2, 0x66, 0x77, 0xc4, 0x00, 0xa2, 0x75,
      0x70, 0x00, 0xa3, 0x72, 0x73, 0x74, 0xa1, 0x70, 0xa5, 0x65, 0x78, 0x74, 0x72,
      0x61, 0xc0,
    ]);
    // string sn: {sn: "abc", fw: bin[], up: 0, rst: "p"}
    const stringSn = new Uint8Array([
      0x84, 0xa2, 0x73, 0x6e, 0xa3, 0x61, 0x62, 0x63, 0xa2, 0x66, 0x77, 0xc4, 0x00,
      0xa2, 0x75, 0x70, 0x00, 0xa3, 0x72, 0x73, 0x74, 0xa1, 0x70,
    ]);
    // negative up: {sn, fw, up: -1, rst: "p"}
    const negativeUp = new Uint8Array([
      0x84, 0xa2, 0x73, 0x6e, 0xc4, 0x00, 0xa2, 0x66, 0x77, 0xc4, 0x00, 0xa2, 0x75,
      0x70, 0xff, 0xa3, 0x72, 0x73, 0x74, 0xa1, 0x70,
    ]);
    // null sn: {sn: nil, fw: bin[], up: 0, rst: "p"}
    const nullSn = new Uint8Array([
      0x84, 0xa2, 0x73, 0x6e, 0xc0, 0xa2, 0x66, 0x77, 0xc4, 0x00, 0xa2, 0x75, 0x70,
      0x00, 0xa3, 0x72, 0x73, 0x74, 0xa1, 0x70,
    ]);

    expect(() => decodeDeviceStat(missingRst)).toThrow(DeviceStatPayloadError);
    expect(() => decodeDeviceStat(unknownField)).toThrow(DeviceStatPayloadError);
    expect(() => decodeDeviceStat(stringSn)).toThrow(DeviceStatPayloadError);
    expect(() => decodeDeviceStat(negativeUp)).toThrow(DeviceStatPayloadError);
    expect(() => decodeDeviceStat(nullSn)).toThrow(DeviceStatPayloadError);
  });

  test("rejects duplicate fields", () => {
    // {sn: bin[], sn: bin[], fw: bin[], up: 0, rst: "p"} — duplicate sn
    const dupSn = new Uint8Array([
      0x85, 0xa2, 0x73, 0x6e, 0xc4, 0x00, 0xa2, 0x73, 0x6e, 0xc4, 0x00, 0xa2, 0x66,
      0x77, 0xc4, 0x00, 0xa2, 0x75, 0x70, 0x00, 0xa3, 0x72, 0x73, 0x74, 0xa1, 0x70,
    ]);
    expect(() => decodeDeviceStat(dupSn)).toThrow(DeviceStatPayloadError);
  });

  test("rejects trailing bytes", () => {
    const stat = {
      sn: new Uint8Array([1, 2, 3]),
      fw: new Uint8Array([0xaa, 0xbb]),
      up: 42n,
      rst: "power-on",
    };
    const payload = Buffer.concat([
      encodeDeviceStat(stat),
      Buffer.from([0xff, 0xff, 0xff]),
    ]);
    expect(() => decodeDeviceStat(payload)).toThrow(DeviceStatPayloadError);
  });

  test("rejects truncated payload", () => {
    const stat = {
      sn: new Uint8Array([1, 2, 3]),
      fw: new Uint8Array([0xaa, 0xbb]),
      up: 42n,
      rst: "power-on",
    };
    const payload = encodeDeviceStat(stat);
    expect(() => decodeDeviceStat(payload.subarray(0, payload.length - 1))).toThrow(
      DeviceStatPayloadError,
    );
  });
});
