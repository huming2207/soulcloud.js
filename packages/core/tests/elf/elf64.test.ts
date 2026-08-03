import { describe, expect, test } from "bun:test";
import {
  ElfParseError,
  extractStrings,
  parseElf,
  readStringAtVaddr,
} from "../../src/elf/parser";
import { buildTestElf } from "../helpers/elf-builder";

describe("64-bit ELF robustness", () => {
  test("parses a 64-bit ELF with a PT_LOAD segment", () => {
    const content = Uint8Array.from([...new TextEncoder().encode("value=%d"), 0, ...new TextEncoder().encode("tag"), 0]);
    const elfBytes = buildTestElf({
      bits: 64,
      littleEndian: true,
      machine: 62, // x86-64
      sections: [
        {
          name: ".noload_keep_in_elf.0",
          type: 1,
          flags: 2, // SHF_ALLOC, but NOT inside the PT_LOAD segment
          addr: 0x10000,
          content,
        },
        // a normal allocated section INSIDE the PT_LOAD segment
        {
          name: ".rodata",
          type: 1,
          flags: 2,
          addr: 0x20000,
          content: Uint8Array.from([...new TextEncoder().encode("rodata-str"), 0]),
        },
      ],
      loadSegment: { sectionIndex: 1 }, // .rodata
    });
    const elf = parseElf(elfBytes);
    expect(elf.bits).toBe(64);
    expect(elf.loads).toHaveLength(1);
    expect(elf.loads[0]!.vaddr).toBe(0x20000n);

    // PT_LOAD path resolves .rodata
    expect(readStringAtVaddr(elf, elfBytes, 0x20000)).toBe("rodata-str");
    // section fallback resolves the .noload address (not in PT_LOAD)
    expect(readStringAtVaddr(elf, elfBytes, 0x10000)).toBe("value=%d");
  });

  test("parses 64-bit big-endian end to end", () => {
    const content = Uint8Array.from([...new TextEncoder().encode("fmt %d"), 0]);
    const elfBytes = buildTestElf({
      bits: 64,
      littleEndian: false,
      machine: 20, // ppc64
      sections: [
        { name: ".noload_keep_in_elf.0", type: 1, flags: 2, addr: 0x100000000, content },
      ],
    });
    const elf = parseElf(elfBytes);
    expect(elf.littleEndian).toBe(false);
    const sec = elf.sections.find((s) => s.name.startsWith(".noload_keep_in_elf"))!;
    expect(sec.addr).toBe(0x100000000n);
    const strings = extractStrings(elf, elfBytes, sec.name);
    expect(strings.map((s) => s.value)).toEqual(["fmt %d"]);
    expect(readStringAtVaddr(elf, elfBytes, 0x100000000)).toBe("fmt %d");
  });

  test("handles addresses above 4GiB (bigint path)", () => {
    const content = Uint8Array.from([...new TextEncoder().encode("high-mem"), 0]);
    const elfBytes = buildTestElf({
      bits: 64,
      littleEndian: true,
      machine: 0,
      sections: [
        { name: ".noload_keep_in_elf.0", type: 1, flags: 2, addr: 0x1_0000_0000, content },
      ],
    });
    const elf = parseElf(elfBytes);
    expect(readStringAtVaddr(elf, elfBytes, 0x1_0000_0000)).toBe("high-mem");
    // addresses in 32-bit range must NOT match the 64-bit section
    expect(readStringAtVaddr(elf, elfBytes, 0x0000_0000)).toBeNull();
    // the NUL terminator position resolves to an empty string
    expect(readStringAtVaddr(elf, elfBytes, 0x1_0000_0008)).toBe("");
    // just outside the section
    expect(readStringAtVaddr(elf, elfBytes, 0x1_0000_0009)).toBeNull();
  });

  test("64-bit ELF with truncated program headers is rejected", () => {
    const elfBytes = buildTestElf({
      bits: 64,
      littleEndian: true,
      machine: 62,
      sections: [{ name: ".noload_keep_in_elf.0", type: 1, flags: 2, addr: 0x1000, content: new Uint8Array([0x41, 0x00]) }],
      loadSegment: { sectionIndex: 0 },
    });
    // cut in the middle of the phdr table
    expect(() => parseElf(elfBytes.subarray(0, 40))).toThrow(ElfParseError);
  });

  test("64-bit ELF with absurd section header sizes is rejected", () => {
    const elfBytes = buildTestElf({
      bits: 64,
      littleEndian: true,
      machine: 0,
      sections: [{ name: ".noload_keep_in_elf.0", type: 1, flags: 2, addr: 0x1000, content: new Uint8Array([0x41, 0x00]) }],
    });
    const tampered = Uint8Array.from(elfBytes);
    // e_shentsize at offset 58 for ELF64: set to a huge value
    tampered[58] = 0xff;
    tampered[59] = 0xff;
    expect(() => parseElf(tampered)).toThrow(/section header size|truncated/);
  });

  test("64-bit ELF with huge shoff does not crash (bounds check)", () => {
    const elfBytes = buildTestElf({
      bits: 64,
      littleEndian: true,
      machine: 0,
      sections: [{ name: ".noload_keep_in_elf.0", type: 1, flags: 2, addr: 0x1000, content: new Uint8Array([0x41, 0x00]) }],
    });
    const tampered = Uint8Array.from(elfBytes);
    // e_shoff at offset 40 for ELF64: set to 0xFFFFFFFFFFFFFFFF
    tampered.fill(0xff, 40, 48);
    expect(() => parseElf(tampered)).toThrow(ElfParseError);
  });

  test("readStringAtVaddr ignores non-ALLOC sections (shstrtab etc.)", () => {
    const content = Uint8Array.from([...new TextEncoder().encode("real"), 0]);
    const elfBytes = buildTestElf({
      bits: 64,
      littleEndian: true,
      machine: 0,
      sections: [
        { name: ".noload_keep_in_elf.0", type: 1, flags: 2, addr: 0x1000, content },
      ],
    });
    const elf = parseElf(elfBytes);
    // vaddr 0 must not resolve through .shstrtab (non-ALLOC, addr 0)
    expect(readStringAtVaddr(elf, elfBytes, 0x0)).toBeNull();
  });
});
