import { describe, expect, test } from "bun:test";
import { canonicalJson, sha256Hex } from "../src";

describe("manifest canonicalization", () => {
  test("sorts object keys without changing array order", async () => {
    expect(canonicalJson({ z: 1, a: { y: true, x: "ok" }, list: [2, 1] })).toBe('{"a":{"x":"ok","y":true},"list":[2,1],"z":1}');
    expect(await sha256Hex(canonicalJson({ b: 1, a: 2 }))).toBe(await sha256Hex(canonicalJson({ a: 2, b: 1 })));
  });

  test("rejects unsupported manifest values", () => {
    expect(() => canonicalJson({ value: undefined })).toThrow();
    expect(() => canonicalJson({ value: Number.NaN })).toThrow();
  });
});
