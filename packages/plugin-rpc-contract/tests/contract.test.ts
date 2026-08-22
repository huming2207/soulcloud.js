import { expect, test } from "bun:test";
import {
  PLUGIN_RPC_D2H_PREFIX,
  PLUGIN_RPC_H2D_PREFIX,
  commandEnqueueInput,
  handleEventInput,
  handleEventOutput,
  assertRpcValueBudget,
  decodePluginJsonValue,
  encodePluginJsonValue,
} from "../src";

test("contract keeps the two WebSocket directions distinct", () => {
  expect(PLUGIN_RPC_D2H_PREFIX).not.toBe(PLUGIN_RPC_H2D_PREFIX);
  expect(PLUGIN_RPC_D2H_PREFIX).toContain("d2h");
  expect(PLUGIN_RPC_H2D_PREFIX).toContain("h2d");
});

test("contract accepts operation-scoped event and binary command arguments", () => {
  const event = handleEventInput.parse({
    operationId: "op-1",
    operationToken: "0123456789abcdef",
    eventId: "event-1",
    eventKind: "telemetry",
    schemaVersion: 1,
    payload: { temperature: 20 },
    device: {
      id: "device-1",
      deviceUid: "uid-1",
      profileId: "profile-1",
      profileVersion: 1,
    },
    installation: { id: "installation-1", projectId: "project-1", config: {} },
    receivedAt: "2026-08-22T00:00:00.000Z",
    deadlineMs: 5_000,
  });
  expect(event.eventId).toBe("event-1");

  const command = commandEnqueueInput.parse({
    operationId: "op-1",
    operationToken: "0123456789abcdef",
    command: "flash",
    args: [{ name: "image", value: new Blob([new Uint8Array([1, 2, 3])]) }],
  });
  expect(command.args[0]?.value).toBeInstanceOf(Blob);
});

test("contract bounds malformed plugin output", () => {
  expect(() => handleEventOutput.parse({ updates: Array(4097).fill({}) })).toThrow();
});

test("RPC value budget rejects deep graphs, cycles and oversized Blobs", () => {
  const budget = {
    maxDepth: 2,
    maxNodes: 8,
    maxArrayItems: 4,
    maxStringBytes: 8,
    maxBlobs: 1,
    maxBlobBytes: 3,
    maxTotalBlobBytes: 3,
  };
  expect(() => assertRpcValueBudget({ a: { b: { c: 1 } } }, budget)).toThrow("depth");
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  expect(() => assertRpcValueBudget(cyclic, budget)).toThrow("cycle");
  expect(() => assertRpcValueBudget({ a: "1234", b: "5678" }, budget)).toThrow("string byte");
  expect(() => assertRpcValueBudget(new Blob([new Uint8Array([1, 2, 3, 4])]), budget)).toThrow("Blob size");
  expect(() => assertRpcValueBudget(new Uint8Array([1, 2, 3, 4]), budget)).toThrow("Blob size");
});

test("JSON control bridge preserves binary and bigint command scalars", () => {
  const value = [{ raw: new Uint8Array([1, 2, 3]), sequence: 2n ** 60n }];
  const decoded = decodePluginJsonValue(encodePluginJsonValue(value)) as Array<Record<string, unknown>>;
  expect(decoded[0]?.raw).toEqual(new Uint8Array([1, 2, 3]));
  expect(decoded[0]?.sequence).toBe(2n ** 60n);
});
