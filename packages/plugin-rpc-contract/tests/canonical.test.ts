import { describe, expect, test } from "bun:test";
import { assertRpcValueBudget, artifactChunkInput, canonicalJson, eventOutput, rpcBinaryFromBlob, rpcBinaryToBlob, sha256BytesHex, sha256Hex } from "../src";

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
    expect(artifactChunkInput.safeParse({ ...base, final: false, chunk: new Blob([Uint8Array.of(1, 2, 3)]) }).success).toBe(true);
  });

  test("rejects final chunks that overrun or stop before the declared size", () => {
    expect(artifactChunkInput.safeParse({ ...base, offset: 3, final: true, chunk: new Blob([Uint8Array.of(1, 2)]) }).success).toBe(false);
    expect(artifactChunkInput.safeParse({ ...base, offset: 0, final: true, chunk: new Blob([Uint8Array.of(1, 2, 3)]) }).success).toBe(false);
  });
});
