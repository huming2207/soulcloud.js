import { describe, expect, test } from "bun:test";
import {
  ElfParseError,
  extractStrings,
  parseElf,
  readStringAtVaddr,
} from "../../src/elf/parser";
import { buildNoloadElf, buildTestElf } from "../helpers/elf-builder";

describe("parseElf", () => {
  test("parses a minimal ELF32 little-endian", () => {
    const elf = parseElf(buildNoloadElf(["value=%d", "tag"], [], 32, true));
    expect(elf.bits).toBe(32);
    expect(elf.littleEndian).toBe(true);
    expect(elf.sections.length).toBeGreaterThanOrEqual(3);
    const noload = elf.sections.find((s) => s.name.startsWith(".noload_keep_in_elf"));
    expect(noload).toBeDefined();
    expect(noload!.addr).toBe(0x40000000n);
  });

  test("parses ELF64 little-endian and ELF32 big-endian", () => {
    const elf64 = parseElf(buildNoloadElf(["fmt %d"], [], 64, true, 0x10000));
    expect(elf64.bits).toBe(64);
    expect(elf64.littleEndian).toBe(true);

    const elf32be = parseElf(buildNoloadElf(["fmt"], [], 32, false, 0x1000));
    expect(elf32be.bits).toBe(32);
    expect(elf32be.littleEndian).toBe(false);
    // big-endian string extraction must work too
    const sec = elf32be.sections.find((s) => s.name.startsWith(".noload_keep_in_elf"))!;
    const strings = extractStrings(elf32be, buildNoloadElf(["fmt"], [], 32, false, 0x1000), sec);
    expect(strings.some((s) => s.value === "fmt")).toBe(true);
  });

  test("rejects non-ELF input", () => {
    expect(() => parseElf(new TextEncoder().encode("not an elf at all"))).toThrow(
      ElfParseError,
    );
    expect(() => parseElf(new Uint8Array(10).fill(0x7f))).toThrow(ElfParseError);
  });

  test("rejects bad class and data encoding bytes", () => {
    const elf = buildNoloadElf(["x"], []);
    const badClass = Uint8Array.from(elf);
    badClass[4] = 3; // class must be 1 or 2
    expect(() => parseElf(badClass)).toThrow(/class/);

    const badData = Uint8Array.from(elf);
    badData[5] = 9;
    expect(() => parseElf(badData)).toThrow(/data encoding/);
  });

  test("rejects truncated ELF", () => {
    const elf = buildNoloadElf(["value=%d"], []);
    // cut in the middle of the section header table
    expect(() => parseElf(elf.subarray(0, 80))).toThrow(ElfParseError);
  });

  test("rejects invalid section name table index", () => {
    const elf = buildNoloadElf(["x"], []);
    const tampered = Uint8Array.from(elf);
    // e_shstrndx at offset 50 for ELF32
    tampered[50] = 0xff;
    tampered[51] = 0xff;
    expect(() => parseElf(tampered)).toThrow(/string table index/);
  });
});

describe("extractStrings", () => {
  test("extracts NUL-separated strings with addresses", () => {
    const elfBytes = buildNoloadElf(["value=%d", "plain"], [], 32, true);
    const elf = parseElf(elfBytes);
    const sec = elf.sections.find((s) => s.name.startsWith(".noload_keep_in_elf"))!;
    const strings = extractStrings(elf, elfBytes, sec);
    expect(strings).toHaveLength(2);
    expect(strings[0]).toEqual({ addr: 0x40000000, value: "value=%d" });
    expect(strings[1]).toEqual({ addr: 0x40000009, value: "plain" });
  });

  test("skips binary garbage (non-text bytes)", () => {
    const content = Uint8Array.from([...new TextEncoder().encode("ok=%d"), 0, 0xff, 0xfe, 0x01, 0, ...new TextEncoder().encode("second"), 0]);
    const elfBytes = buildTestElf({
      bits: 32,
      littleEndian: true,
      machine: 0,
      sections: [{ name: ".noload_keep_in_elf.0", type: 1, flags: 2, addr: 0x1000, content }],
    });
    const elf = parseElf(elfBytes);
    const sec = elf.sections.find((s) => s.name.startsWith(".noload_keep_in_elf"))!;
    const strings = extractStrings(elf, elfBytes, sec);
    expect(strings.map((s) => s.value)).toEqual(["ok=%d", "second"]);
  });

  test("returns empty for missing sections", () => {
    const elf = parseElf(buildNoloadElf(["x"], []));
    expect(extractStrings(elf, new Uint8Array(0), elf.sections[0]!)).toEqual([]);
  });

  test("handles NOBITS sections", () => {
    const elfBytes = buildTestElf({
      bits: 32,
      littleEndian: true,
      machine: 0,
      sections: [
        { name: ".noload_keep_in_elf.0", type: 8, flags: 2, addr: 0x1000, content: new Uint8Array(64) },
      ],
    });
    const elf = parseElf(elfBytes);
    const sec = elf.sections.find((s) => s.name.startsWith(".noload_keep_in_elf"))!;
    expect(extractStrings(elf, elfBytes, sec)).toEqual([]);
  });
});

describe("readStringAtVaddr", () => {
  test("resolves strings in .noload sections (not in PT_LOAD)", () => {
    const elfBytes = buildNoloadElf(["value=%d", "tag"], [], 32, true);
    const elf = parseElf(elfBytes);
    // buildNoloadElf has no PT_LOAD segments; resolution falls back to
    // allocated sections (which is exactly how .noload addresses work)
    expect(readStringAtVaddr(elf, elfBytes, 0x40000000)).toBe("value=%d");
    expect(readStringAtVaddr(elf, elfBytes, 0x40000009)).toBe("tag");
  });

  test("returns null for unmapped addresses", () => {
    const elfBytes = buildNoloadElf(["x"], []);
    const elf = parseElf(elfBytes);
    expect(readStringAtVaddr(elf, elfBytes, 0xdeadbeef)).toBeNull();
    expect(readStringAtVaddr(elf, elfBytes, 0x0)).toBeNull();
  });

  test("returns null for unterminated strings", () => {
    const content = Uint8Array.from([...new TextEncoder().encode("no-nul-terminator")]);
    const elfBytes = buildTestElf({
      bits: 32,
      littleEndian: true,
      machine: 0,
      sections: [{ name: ".noload_keep_in_elf.0", type: 1, flags: 2, addr: 0x1000, content }],
    });
    const elf = parseElf(elfBytes);
    expect(readStringAtVaddr(elf, elfBytes, 0x1000)).toBeNull();
  });

  test("respects the max length", () => {
    const content = Uint8Array.from([...new TextEncoder().encode("a".repeat(100)), 0]);
    const elfBytes = buildTestElf({
      bits: 32,
      littleEndian: true,
      machine: 0,
      sections: [{ name: ".noload_keep_in_elf.0", type: 1, flags: 2, addr: 0x1000, content }],
    });
    const elf = parseElf(elfBytes);
    expect(readStringAtVaddr(elf, elfBytes, 0x1000, 10)).toBeNull(); // no NUL within 10
    expect(readStringAtVaddr(elf, elfBytes, 0x1000, 200)).toBe("a".repeat(100));
  });
});
