import { describe, expect, test } from "bun:test";
import { assertRpcValueBudget, canonicalJson, sha256Hex } from "../src";

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
