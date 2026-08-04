import { describe, expect, test } from "bun:test";
import { validateMessagePackStructure } from "../../src/protocol/structure";

describe("structure depth limit (M4)", () => {
  test("deep nesting is rejected with a typed error", () => {
    // 100000 nested fixarrays (each 0x91 = array of 1), innermost element 0x00
    const deep = new Uint8Array(100001);
    deep.fill(0x91, 0, 100000);
    deep[100000] = 0x00;
    expect(() => validateMessagePackStructure(deep)).toThrow(/nesting exceeds limit/);
  });

  test("normal nesting is accepted", () => {
    // [[1]] : array(1) of array(1) of int
    const ok = new Uint8Array([0x91, 0x91, 0x01]);
    expect(() => validateMessagePackStructure(ok)).not.toThrow();
  });

  test("deeply nested maps are also limited", () => {
    // map with one string key -> nested map, 100000 levels
    // each level: 0x81 (map len 1) + key "k" (0xa1 0x6b)
    const deep = new Uint8Array(100000 * 3 + 1);
    for (let i = 0; i < 100000; i++) {
      deep[i * 3] = 0x81;
      deep[i * 3 + 1] = 0xa1;
      deep[i * 3 + 2] = 0x6b;
    }
    deep[deep.length - 1] = 0x00;
    expect(() => validateMessagePackStructure(deep)).toThrow(/nesting exceeds limit/);
  });
});
