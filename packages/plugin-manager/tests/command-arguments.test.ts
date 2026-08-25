import { describe, expect, test } from "bun:test";
import { normalizeCommandArguments } from "../src/manager";

describe("plugin command argument boundary", () => {
  test("keeps scalar values and converts Blob values to device bytes", async () => {
    const result = await normalizeCommandArguments([
      { name: "count", value: 3 },
      { name: "enabled", value: true },
      { name: "payload", value: new Blob([Uint8Array.of(1, 2, 3)]) },
      { name: "empty", value: null },
    ]);
    expect(result[0]).toEqual({ count: 3 });
    expect(result[1]).toEqual({ enabled: true });
    expect(result[2]?.payload).toBeInstanceOf(Uint8Array);
    expect(result[2]?.payload).toEqual(Uint8Array.of(1, 2, 3));
    expect(result[3]).toEqual({ empty: null });
  });

  test("rejects nested values and non-finite numbers", async () => {
    await expect(normalizeCommandArguments([{ name: "nested", value: { bad: true } }])).rejects.toThrow("must be scalar");
    await expect(normalizeCommandArguments([{ name: "nan", value: Number.NaN }])).rejects.toThrow("must be scalar");
    await expect(normalizeCommandArguments([{ name: "infinity", value: Number.POSITIVE_INFINITY }])).rejects.toThrow("must be scalar");
  });

  test("rejects malformed argument lists", async () => {
    await expect(normalizeCommandArguments({ name: "not-an-array", value: 1 })).rejects.toThrow("must be an array");
    await expect(normalizeCommandArguments([{ name: "", value: 1 }])).rejects.toThrow("bounded name");
    await expect(normalizeCommandArguments([{ name: "missing" }])).rejects.toThrow("bounded name");
    await expect(normalizeCommandArguments([{ name: "same", value: 1 }, { name: "same", value: 2 }])).rejects.toThrow("duplicated");
  });
});
