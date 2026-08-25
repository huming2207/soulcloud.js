import { describe, expect, test } from "bun:test";
import { validateArtifact } from "../src/artifact";

describe("SoulInjector artifact envelope", () => {
  test("accepts ELF without copying the input view", () => {
    const bytes = new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 2, 1]);
    const result = validateArtifact({ kind: "elf", filename: "firmware.elf", bytes });
    expect(result.bytes).toBe(bytes);
    expect(result.size).toBe(6);
    expect(result.sha256).toHaveLength(64);
  });

  test("allows raw firmware but rejects path traversal and invalid ELF", () => {
    expect(() => validateArtifact({ kind: "elf", filename: "firmware.elf", bytes: new Uint8Array([1, 2, 3]) })).toThrow("ELF magic");
    expect(validateArtifact({ kind: "firmware", filename: "image.bin", bytes: new Uint8Array([1, 2, 3]) }).kind).toBe("firmware");
    expect(() => validateArtifact({ kind: "firmware", filename: "../image.bin", bytes: new Uint8Array([1]) })).toThrow("simple name");
  });
});
