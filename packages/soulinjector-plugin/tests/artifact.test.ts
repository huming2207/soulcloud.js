import { describe, expect, test } from "bun:test";
import { ArtifactValidationError, validateArtifact } from "../src/artifact";

describe("SoulInjector artifact envelope", () => {
  test("accepts ELF without copying the input view", () => {
    const bytes = new Uint8Array(64);
    bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]);
    const header = new DataView(bytes.buffer);
    header.setUint16(16, 2, true);
    header.setUint16(18, 243, true);
    header.setUint32(20, 1, true);
    header.setBigUint64(24, 0x1000n, true);
    header.setUint16(52, 64, true);
    const result = validateArtifact({ kind: "elf", filename: "firmware.elf", bytes });
    expect(result.bytes).toBe(bytes);
    expect(result.size).toBe(64);
    expect(result.sha256).toHaveLength(64);
    expect(result.metadata).toMatchObject({ format: "elf", elfClass: "ELF64", machine: 243, machineName: "riscv", entryAddress: "0x1000" });
  });

  test("allows raw firmware but rejects path traversal and invalid ELF", () => {
    try {
      validateArtifact({ kind: "elf", filename: "firmware.elf", bytes: new Uint8Array([1, 2, 3]) });
      throw new Error("expected invalid ELF");
    } catch (error) {
      expect(error).toBeInstanceOf(ArtifactValidationError);
      expect((error as ArtifactValidationError).code).toBe("INVALID_ARTIFACT_INPUT");
      expect((error as Error).message).toContain("ELF magic");
    }
    expect(validateArtifact({ kind: "firmware", filename: "image.bin", bytes: new Uint8Array([1, 2, 3]) }).kind).toBe("firmware");
    expect(() => validateArtifact({ kind: "firmware", filename: "../image.bin", bytes: new Uint8Array([1]) })).toThrow("simple name");
  });

  test("rejects a truncated or out-of-bounds ELF table", () => {
    expect(() => validateArtifact({ kind: "elf", filename: "firmware.elf", bytes: new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]) })).toThrow("header is truncated");
    const bytes = new Uint8Array(64);
    bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]);
    const header = new DataView(bytes.buffer);
    header.setUint16(52, 64, true);
    header.setUint16(54, 56, true);
    header.setUint16(56, 1, true);
    header.setBigUint64(32, 64n, true);
    expect(() => validateArtifact({ kind: "elf", filename: "firmware.elf", bytes })).toThrow("program header table is outside");
  });
});
