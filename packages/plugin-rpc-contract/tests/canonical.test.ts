import { describe, expect, test } from "bun:test";
import { assertRpcValueBudget, artifactChunkInput, canonicalJson, debugSessionStartInput, debugSessionStartOutput, deviceCancelInput, deviceCommandOutput, deviceEnqueueInput, eventInput, eventOutput, executionCompleteInput, executionOutput, rpcBinaryFromBlob, rpcBinaryToBlob, sha256BytesHex, sha256Hex } from "../src";

describe("manifest canonicalization", () => {
  test("sorts object keys without changing array order", async () => {
    expect(canonicalJson({ z: 1, a: { y: true, x: "ok" }, list: [2, 1] })).toBe('{"a":{"x":"ok","y":true},"list":[2,1],"z":1}');
    expect(await sha256Hex(canonicalJson({ b: 1, a: 2 }))).toBe(await sha256Hex(canonicalJson({ a: 2, b: 1 })));
  });

  test("rejects unsupported manifest values", () => {
    expect(() => canonicalJson({ value: undefined })).toThrow();
    expect(() => canonicalJson({ value: Number.NaN })).toThrow();
  });

  test("counts binary values by bytes rather than one node per byte", () => {
    expect(() => assertRpcValueBudget(new Uint8Array(8_192), {
      maxDepth: 4,
      maxNodes: 8,
      maxArrayItems: 8,
      maxStringBytes: 32,
      maxBlobs: 1,
      maxBlobBytes: 8_192,
      maxTotalBlobBytes: 8_192,
    })).not.toThrow();
  });
});

describe("RPC integer bounds", () => {
  test("accepts uint64 Entity sequences without accepting larger values", () => {
    const update = (sequence: bigint) => ({ updates: [{ entityKey: "counter", sequence }], logs: [] });
    expect(eventOutput.safeParse(update((1n << 64n) - 1n)).success).toBe(true);
    expect(eventOutput.safeParse(update(1n << 64n)).success).toBe(false);
  });
});

describe("debug execution RPC contract", () => {
  const base = {
    operationId: "execution-operation",
    operationToken: "execution-operation-token-12345678901234567890",
    deadlineMs: 1_000,
    executionId: "00000000-0000-4000-8000-000000000001",
    executionToken: "execution-capability-token-12345678901234567890",
  };

  test("validates execution output without exposing a token hash", () => {
    const output = executionOutput.parse({
      id: base.executionId,
      installationId: "00000000-0000-4000-8000-000000000002",
      deviceId: "00000000-0000-4000-8000-000000000003",
      initiatingUserId: "00000000-0000-4000-8000-000000000004",
      pluginId: "debugger",
      pluginVersion: "1.0.0",
      manifestHash: "a".repeat(64),
      allowedCapabilities: ["execution.get"],
      state: "active",
      deviceLeaseExpiresAt: new Date(1_000).toISOString(),
      expiresAt: new Date(2_000).toISOString(),
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(1_000).toISOString(),
      finishedAt: null,
    });
    expect(output).not.toHaveProperty("executionToken");
    expect(executionCompleteInput.safeParse({ ...base, state: "completed" }).success).toBe(true);
  });

  test("allows an optional execution context on event input", () => {
    const result = eventInput.safeParse({
      operationId: base.operationId,
      operationToken: base.operationToken,
      deadlineMs: base.deadlineMs,
      event: { id: "event", seq: 1n, kind: "debug", schema: 1, receivedAt: new Date(0).toISOString(), payload: {} },
      installation: { id: "installation", projectId: "00000000-0000-4000-8000-000000000002", pluginId: "debugger", pluginVersion: "1.0.0", config: {} },
      device: { id: "00000000-0000-4000-8000-000000000003", uid: "device", profileId: "debug", profileVersion: 1 },
      execution: { executionId: base.executionId, executionToken: base.executionToken },
    });
    expect(result.success).toBe(true);
  });

  test("keeps device command capability inputs scoped to an execution", () => {
    const input = deviceEnqueueInput.safeParse({
      ...base,
      command: "debug.identify",
      args: [],
      idempotencyKey: "identify-1",
    });
    expect(input.success).toBe(true);
    expect(deviceCancelInput.safeParse({ ...base, commandId: "00000000-0000-4000-8000-000000000005" }).success).toBe(true);
    expect(deviceCommandOutput.safeParse({
      id: "00000000-0000-4000-8000-000000000005",
      batchId: "00000000-0000-4000-8000-000000000006",
      deviceId: "00000000-0000-4000-8000-000000000003",
      sequence: 1n,
      state: "queued",
      resultCode: null,
      cancelRequestedAt: null,
      brokerAcceptedAt: null,
      deviceCompletedAt: null,
      createdAt: new Date(0).toISOString(),
    }).success).toBe(true);
  });
});

describe("debug session bootstrap RPC contract", () => {
  const base = {
    operationId: "session-operation",
    operationToken: "session-operation-token-12345678901234567890",
    deadlineMs: 1_000,
    installationId: "00000000-0000-4000-8000-000000000001",
    projectId: "00000000-0000-4000-8000-000000000002",
    deviceId: "00000000-0000-4000-8000-000000000003",
    userId: "00000000-0000-4000-8000-000000000004",
    pluginVersion: "0.1.0",
    manifestHash: "a".repeat(64),
    executionId: "00000000-0000-4000-8000-000000000005",
    executionToken: "session-execution-token-12345678901234567890",
    caseId: "00000000-0000-4000-8000-000000000006",
  };

  test("requires target snapshot fields to be all-or-nothing", () => {
    expect(debugSessionStartInput.safeParse({ ...base }).success).toBe(true);
    expect(debugSessionStartInput.safeParse({ ...base, targetConfigRevision: 1 }).success).toBe(false);
    expect(debugSessionStartInput.safeParse({ ...base, targetConfigId: "00000000-0000-4000-8000-000000000007", targetConfigRevision: 1, targetId: "fixture" }).success).toBe(true);
    expect(debugSessionStartOutput.parse({ sessionId: base.executionId, executionId: base.executionId })).toEqual({ sessionId: base.executionId, executionId: base.executionId });
  });
});

describe("RPC binary adapter", () => {
  test("hashes exact binary asset bytes", async () => {
    expect(await sha256BytesHex(Uint8Array.of(99, 111, 110, 115, 116))).toBe("f75c6596507878933aa2bc17dfd9a8689ad0da4f85427ba457666ae5917fa631");
  });

  test("round-trips root and nested Uint8Array values through Blob", async () => {
    const wire = rpcBinaryToBlob({
      raw: Uint8Array.of(1, 2, 3),
      nested: { sample: Uint8Array.of(4, 5) },
      list: [Uint8Array.of(6)],
      text: "keep",
    });
    expect(wire).toEqual({
      raw: expect.any(Blob),
      nested: { sample: expect.any(Blob) },
      list: [expect.any(Blob)],
      text: "keep",
    });

    const restored = await rpcBinaryFromBlob(wire);
    expect(restored).toEqual({
      raw: Uint8Array.of(1, 2, 3),
      nested: { sample: Uint8Array.of(4, 5) },
      list: [Uint8Array.of(6)],
      text: "keep",
    });
    expect((restored as { raw: unknown }).raw).toBeInstanceOf(Uint8Array);
  });

  test("is idempotent for values that already crossed the wire", async () => {
    const original = { blob: new Blob([Uint8Array.of(1)]) };
    const wire = rpcBinaryToBlob(original);
    expect(wire).toEqual(original);
    expect((wire as { blob: Blob }).blob).toBe(original.blob);
    expect(await rpcBinaryFromBlob({ text: "plain" })).toEqual({ text: "plain" });
  });
});

describe("artifact chunk contract", () => {
  const base = {
    operationId: "operation-id-123456",
    operationToken: "operation-token-12345678901234567890",
    deadlineMs: 1_000,
    installationId: "00000000-0000-4000-8000-000000000001",
    projectId: "00000000-0000-4000-8000-000000000002",
    userId: "00000000-0000-4000-8000-000000000003",
    uploadId: "00000000-0000-4000-8000-000000000004",
    kind: "firmware" as const,
    filename: "image.bin",
    contentType: "application/octet-stream",
    totalSize: 4,
    offset: 0,
  };

  test("requires a non-final chunk to leave room for the final chunk", () => {
    expect(artifactChunkInput.safeParse({ ...base, final: false, chunk: new Blob([Uint8Array.of(1, 2, 3, 4)]) }).success).toBe(false);
    expect(artifactChunkInput.safeParse({ ...base, final: true, chunk: new Blob([Uint8Array.of(1, 2, 3, 4)]) }).success).toBe(true);
    expect(artifactChunkInput.safeParse({ ...base, caseId: "00000000-0000-4000-8000-000000000005", final: false, chunk: new Blob([Uint8Array.of(1, 2, 3)]) }).success).toBe(true);
  });

  test("rejects final chunks that overrun or stop before the declared size", () => {
    expect(artifactChunkInput.safeParse({ ...base, offset: 3, final: true, chunk: new Blob([Uint8Array.of(1, 2)]) }).success).toBe(false);
    expect(artifactChunkInput.safeParse({ ...base, offset: 0, final: true, chunk: new Blob([Uint8Array.of(1, 2, 3)]) }).success).toBe(false);
  });
});
