import { describe, expect, test } from "bun:test";
import { assertRpcValueBudget, canonicalJson, eventOutput, rpcBinaryFromBlob, rpcBinaryToBlob, sha256Hex } from "../src";

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
