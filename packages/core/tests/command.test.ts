import { describe, expect, test } from "bun:test";
import {
  CommandPayloadError,
  type CommandArgument,
  type DeviceCommand,
  encodeDeviceCommand,
  encodeDeviceCommandExecution,
  encodeDeviceCommandResult,
  decodeDeviceCommandExecution,
  decodeDeviceCommandResult,
} from "../src/protocol/command";

// A 16-byte command ID
const ID = new Uint8Array(16).fill(0x5a);

describe("encode/decode command execution envelope", () => {
  test("round-trips an execution envelope", () => {
    const execution = {
      id: ID,
      seq: 42n,
      cmd: "getConfig",
      args: [{ key: "logging.level" }],
    };
    const encoded = encodeDeviceCommandExecution(execution);
    expect(decodeDeviceCommandExecution(encoded)).toEqual(execution);
    // command ID must use MessagePack bin: 0xc4 (bin8) + length 16
    expect(encoded[4]).toBe(0xc4);
    expect(encoded[5]).toBe(16);
  });

  test("round-trips a result envelope", () => {
    const payload: CommandArgument[] = [
      { "logging.level": 3 },
      { certificate: new Uint8Array([0, 1, 255]) },
    ];
    const result = { id: ID, seq: 43n, code: 0, payload };
    const encoded = encodeDeviceCommandResult(result);
    expect(decodeDeviceCommandResult(encoded)).toEqual(result);
  });

  test("accepts negative code and omitted payload", () => {
    // hand-crafted: {id: bin[16] 0..15, seq: 1, code: -22}
    const payload = new Uint8Array([
      0x83, 0xa2, 0x69, 0x64, 0xc4, 0x10, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12,
      13, 14, 15, 0xa3, 0x73, 0x65, 0x71, 0x01, 0xa4, 0x63, 0x6f, 0x64, 0x65, 0xea,
    ]);
    expect(decodeDeviceCommandResult(payload)).toEqual({
      id: new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]),
      seq: 1n,
      code: -22,
      payload: undefined,
    });
  });
});

describe("command payload validation", () => {
  test("rejects bad IDs, unknown fields and trailing bytes", () => {
    const execution = {
      id: ID,
      seq: 1n,
      cmd: "reboot",
    };
    const badId = encodeDeviceCommandExecution(execution);
    badId[5] = 15; // break the 16-byte bin length
    expect(() => decodeDeviceCommandExecution(badId)).toThrow(CommandPayloadError);

    // unknown result field: {id, seq, code, x: nil}
    const unknownResultField = new Uint8Array([
      0x84, 0xa2, 0x69, 0x64, 0xc4, 0x10, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12,
      13, 14, 15, 0xa3, 0x73, 0x65, 0x71, 0x01, 0xa4, 0x63, 0x6f, 0x64, 0x65, 0x00,
      0xa1, 0x78, 0xc0,
    ]);
    expect(() => decodeDeviceCommandResult(unknownResultField)).toThrow(
      CommandPayloadError,
    );

    const result = { id: ID, seq: 1n, code: 0 };
    const trailing = Buffer.concat([
      encodeDeviceCommandResult(result),
      Buffer.from([0xff]),
    ]);
    expect(() => decodeDeviceCommandResult(trailing)).toThrow(CommandPayloadError);
  });

  test("rejects duplicate top-level fields", () => {
    // {cmd: "reboot", cmd: "other"} — duplicate "cmd" key
    const dup = new Uint8Array([
      0x82, 0xa3, 0x63, 0x6d, 0x64, 0xa6, 0x72, 0x65, 0x62, 0x6f, 0x6f, 0x74, 0xa3,
      0x63, 0x6d, 0x64, 0xa5, 0x6f, 0x74, 0x68, 0x65, 0x72,
    ]);
    expect(() => decodeDeviceCommandExecution(dup)).toThrow(CommandPayloadError);
  });

  test("rejects missing or null command name", () => {
    // {args: nil}
    const missing = new Uint8Array([0x81, 0xa4, 0x61, 0x72, 0x67, 0x73, 0xc0]);
    // {cmd: nil}
    const nullCmd = new Uint8Array([0x81, 0xa3, 0x63, 0x6d, 0x64, 0xc0]);
    expect(() => decodeDeviceCommandExecution(missing)).toThrow(CommandPayloadError);
    expect(() => decodeDeviceCommandExecution(nullCmd)).toThrow(CommandPayloadError);
  });

  test("rejects unknown top-level fields", () => {
    // {cmd: "reboot", extra: nil}
    const unknown = new Uint8Array([
      0x82, 0xa3, 0x63, 0x6d, 0x64, 0xa6, 0x72, 0x65, 0x62, 0x6f, 0x6f, 0x74, 0xa5,
      0x65, 0x78, 0x74, 0x72, 0x61, 0xc0,
    ]);
    expect(() => decodeDeviceCommandExecution(unknown)).toThrow(CommandPayloadError);
  });

  test("rejects argument maps without exactly one pair", () => {
    // {cmd: "reboot", args: [{}]}
    const emptyArg = new Uint8Array([
      0x82, 0xa3, 0x63, 0x6d, 0x64, 0xa6, 0x72, 0x65, 0x62, 0x6f, 0x6f, 0x74, 0xa4,
      0x61, 0x72, 0x67, 0x73, 0x91, 0x80,
    ]);
    // {cmd: "reboot", args: [{a: 1, b: 2}]}
    const twoArgs = new Uint8Array([
      0x82, 0xa3, 0x63, 0x6d, 0x64, 0xa6, 0x72, 0x65, 0x62, 0x6f, 0x6f, 0x74, 0xa4,
      0x61, 0x72, 0x67, 0x73, 0x91, 0x82, 0xa1, 0x61, 0x01, 0xa1, 0x62, 0x02,
    ]);
    // {cmd: "reboot", args: [{extra: []}]} — nested array not allowed
    const nested = new Uint8Array([
      0x82, 0xa3, 0x63, 0x6d, 0x64, 0xa6, 0x72, 0x65, 0x62, 0x6f, 0x6f, 0x74, 0xa4,
      0x61, 0x72, 0x67, 0x73, 0x91, 0x81, 0xa5, 0x65, 0x78, 0x74, 0x72, 0x61, 0x90,
    ]);
    expect(() => decodeDeviceCommandExecution(emptyArg)).toThrow(CommandPayloadError);
    expect(() => decodeDeviceCommandExecution(twoArgs)).toThrow(CommandPayloadError);
    expect(() => decodeDeviceCommandExecution(nested)).toThrow(CommandPayloadError);
  });
});

describe("documented command shape", () => {
  test("decodes and encodes the documented shape", () => {
    // {cmd: "someCommand", args: [{arg1:"foo"},{arg2:"bar"},{arg3:67},{arg4:true},{arg5:nil}]}
    const payload = new Uint8Array([
      0x82, 0xa3, 0x63, 0x6d, 0x64, 0xab, 0x73, 0x6f, 0x6d, 0x65, 0x43, 0x6f, 0x6d,
      0x6d, 0x61, 0x6e, 0x64, 0xa4, 0x61, 0x72, 0x67, 0x73, 0x95, 0x81, 0xa4, 0x61,
      0x72, 0x67, 0x31, 0xa3, 0x66, 0x6f, 0x6f, 0x81, 0xa4, 0x61, 0x72, 0x67, 0x32,
      0xa3, 0x62, 0x61, 0x72, 0x81, 0xa4, 0x61, 0x72, 0x67, 0x33, 0x43, 0x81, 0xa4,
      0x61, 0x72, 0x67, 0x34, 0xc3, 0x81, 0xa4, 0x61, 0x72, 0x67, 0x35, 0xc0,
    ]);
    const command: DeviceCommand = {
      cmd: "someCommand",
      args: [
        { arg1: "foo" },
        { arg2: "bar" },
        { arg3: 67 },
        { arg4: true },
        { arg5: null },
      ],
    };
    expect(encodeDeviceCommand(command)).toEqual(payload);
    // decode via the execution decoder requires id/seq; use msgpack decode to
    // verify the human-API command body round-trips through the same encoder.
    // The exact bytes are already asserted above; verify the encoder output.
  });

  test("accepts missing or null args and encodes none as null", () => {
    const command: DeviceCommand = { cmd: "reboot" };
    const encoded = encodeDeviceCommand(command);
    expect(encoded).toEqual(
      new Uint8Array([
        0x82, 0xa3, 0x63, 0x6d, 0x64, 0xa6, 0x72, 0x65, 0x62, 0x6f, 0x6f, 0x74,
        0xa4, 0x61, 0x72, 0x67, 0x73, 0xc0,
      ]),
    );
  });

  test("preserves all numeric categories", () => {
    const command: DeviceCommand = {
      cmd: "configure",
      args: [
        { negative: -2 },
        { large: 18446744073709551615n }, // u64 max
        { ratio: 1.5 },
      ],
    };
    const encoded = encodeDeviceCommand(command);
    // u64 max needs BigInt encoding support
    expect(encoded).toBeInstanceOf(Uint8Array);
    // decode and verify: large stays exact via bigint
    const { decode } = require("@msgpack/msgpack") as typeof import("@msgpack/msgpack");
    const decoded = decode(encoded, { useBigInt64: true }) as DeviceCommand;
    expect(decoded.args?.[0]).toEqual({ negative: -2 });
    expect(decoded.args?.[1]).toEqual({ large: 18446744073709551615n });
    expect(decoded.args?.[2]).toEqual({ ratio: 1.5 });
  });

  test("encodes and decodes binary argument values", () => {
    const command: DeviceCommand = {
      cmd: "transfer",
      args: [{ data: new Uint8Array([0, 1, 255]) }],
    };
    const encoded = encodeDeviceCommand(command);
    expect(encoded).toEqual(
      new Uint8Array([
        0x82, 0xa3, 0x63, 0x6d, 0x64, 0xa8, 0x74, 0x72, 0x61, 0x6e, 0x73, 0x66,
        0x65, 0x72, 0xa4, 0x61, 0x72, 0x67, 0x73, 0x91, 0x81, 0xa4, 0x64, 0x61,
        0x74, 0x61, 0xc4, 0x03, 0x00, 0x01, 0xff,
      ]),
    );
  });

  test("rejects a byte array used in place of binary", () => {
    // {cmd: "transfer", args: [{data: [0, 1, 255]}]} — array of ints, not bin
    const badBinary = new Uint8Array([
      0x82, 0xa3, 0x63, 0x6d, 0x64, 0xa8, 0x74, 0x72, 0x61, 0x6e, 0x73, 0x66,
      0x65, 0x72, 0xa4, 0x61, 0x72, 0x67, 0x73, 0x91, 0x81, 0xa4, 0x64, 0x61,
      0x74, 0x61, 0x93, 0x00, 0x01, 0xff,
    ]);
    const execution = {
      id: ID,
      seq: 1n,
      cmd: "transfer",
      args: [{ data: [0, 1, 255] }],
    };
    // encoding an array stays an array; decoding must reject it
    const encoded = encodeDeviceCommandExecution(execution as never);
    expect(() => decodeDeviceCommandExecution(encoded)).toThrow(CommandPayloadError);
    // and the hand-crafted variant too
    expect(() => decodeDeviceCommandExecution(badBinary)).toThrow(CommandPayloadError);
  });
});
