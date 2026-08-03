/**
 * Test helper: builds minimal valid ELF files for parser tests.
 *
 * Supports ELF32/ELF64, little/big endian. Sections can be added with
 * explicit content so tests can exercise `.noload_keep_in_elf.*` extraction,
 * read-only tag sections, truncation and other edge cases without external
 * fixture files.
 */

export interface TestSection {
  name: string;
  type: number; // 1 = PROGBITS, 8 = NOBITS
  flags: number; // 1 = WRITE, 2 = ALLOC
  addr: number;
  content: Uint8Array; // empty for NOBITS
}

export interface TestElfOptions {
  bits: 32 | 64;
  littleEndian: boolean;
  machine: number;
  sections: TestSection[];
  /** Optional PT_LOAD segment; the section index provides the file data. */
  loadSegment?: { sectionIndex: number };
}

/** Builds a minimal ELF (executable type) with the given sections. */
export function buildTestElf(options: TestElfOptions): Uint8Array {
  const { bits, littleEndian, machine, sections } = options;
  const is64 = bits === 64;
  const ehSize = is64 ? 64 : 52;
  const phEntSize = is64 ? 56 : 32;
  const shEntSize = is64 ? 64 : 40;
  const hasPh = options.loadSegment !== undefined;
  const phNum = hasPh ? 1 : 0;

  // section name table: null + each name
  const shstrParts: number[] = [0];
  const nameOffsets: number[] = [];
  for (const sec of sections) {
    nameOffsets.push(shstrParts.length);
    shstrParts.push(...new TextEncoder().encode(sec.name), 0);
  }
  // + the shstrtab section's own name
  nameOffsets.push(shstrParts.length);
  shstrParts.push(...new TextEncoder().encode(".shstrtab"), 0);
  const shstr = Uint8Array.from(shstrParts);
  const shstrIdx = sections.length + 1; // null + N + shstrtab

  // layout: header | phdrs | sections (aligned 4) | shstrtab | section headers
  const phOff = ehSize;
  let offset = ehSize + phNum * phEntSize;
  const sectionData: Uint8Array[] = [];
  for (const sec of sections) {
    if (sec.type === 8 || sec.content.length === 0) {
      sectionData.push(new Uint8Array(0));
      continue;
    }
    const aligned = (offset + 3) & ~3;
    offset = aligned;
    sectionData.push(sec.content);
    offset += sec.content.length;
  }
  // shstrtab (aligned)
  offset = (offset + 3) & ~3;
  const shstrOffset = offset;
  offset += shstr.length;
  const shOff = offset; // section header table start

  const out = new Uint8Array(shOff + (sections.length + 2) * shEntSize);

  // --- ELF header -----------------------------------------------------------
  const view = new DataView(out.buffer);
  const u16 = (p: number, v: number) => view.setUint16(p, v, littleEndian);
  const u32 = (p: number, v: number) => view.setUint32(p, v, littleEndian);
  const u64 = (p: number, v: bigint) => view.setBigUint64(p, v, littleEndian);
  out.set([0x7f, 0x45, 0x4c, 0x46], 0); // \x7fELF
  out[4] = is64 ? 2 : 1; // class
  out[5] = littleEndian ? 1 : 2; // data
  out[6] = 1; // version
  u16(16, 2); // e_type = ET_EXEC
  u16(18, machine);
  u32(20, 1); // e_version
  if (is64) {
    u64(24, 0n); // e_entry
    u64(32, BigInt(hasPh ? phOff : 0)); // e_phoff
    u64(40, BigInt(shOff)); // e_shoff
    u32(48, 0); // e_flags
    u16(52, ehSize);
    u16(54, phEntSize);
    u16(56, phNum);
    u16(58, shEntSize);
    u16(60, sections.length + 2); // e_shnum
    u16(62, shstrIdx); // e_shstrndx
  } else {
    u32(24, 0); // e_entry
    u32(28, hasPh ? phOff : 0); // e_phoff
    u32(32, shOff); // e_shoff
    u32(36, 0); // e_flags
    u16(40, ehSize);
    u16(42, phEntSize);
    u16(44, phNum);
    u16(46, shEntSize);
    u16(48, sections.length + 2); // e_shnum
    u16(50, shstrIdx); // e_shstrndx
  }

  // --- program header (PT_LOAD) ----------------------------------------------
  if (hasPh) {
    const seg = options.loadSegment!;
    const sec = sections[seg.sectionIndex]!;
    if (sec.type === 8 || sec.content.length === 0) {
      throw new Error("loadSegment section must have file data");
    }
    // compute the section's file offset: header + phdrs + preceding data
    let fileOffset = ehSize + phNum * phEntSize;
    for (let i = 0; i < seg.sectionIndex; i++) {
      const prev = sections[i]!;
      if (prev.type !== 8 && prev.content.length > 0) {
        fileOffset = (fileOffset + 3) & ~3;
        fileOffset += prev.content.length;
      }
    }
    fileOffset = (fileOffset + 3) & ~3;
    const segOffset = fileOffset;
    const segFilesz = sec.content.length;
    const segVaddr = sec.addr;
    const p = phOff;
    u32(p, 1); // p_type = PT_LOAD
    if (is64) {
      u32(p + 4, 5); // p_flags (R|X)
      u64(p + 8, BigInt(segOffset));
      u64(p + 16, BigInt(segVaddr));
      u64(p + 24, BigInt(segVaddr)); // p_paddr
      u64(p + 32, BigInt(segFilesz));
      u64(p + 40, BigInt(segFilesz)); // p_memsz
      u64(p + 48, 0x1000n); // p_align
    } else {
      u32(p + 4, segOffset);
      u32(p + 8, segVaddr);
      u32(p + 12, segVaddr); // p_paddr
      u32(p + 16, segFilesz);
      u32(p + 20, segFilesz); // p_memsz
      u32(p + 24, 5); // p_flags
      u32(p + 28, 0x1000); // p_align
    }
  }

  // --- section data ----------------------------------------------------------
  let dataPos = ehSize + phNum * phEntSize;
  for (let i = 0; i < sections.length; i++) {
    const sec = sections[i]!;
    if (sectionData[i]!.length > 0) {
      dataPos = (dataPos + 3) & ~3;
      out.set(sectionData[i]!, dataPos);
      dataPos += sectionData[i]!.length;
    }
  }
  out.set(shstr, shstrOffset);

  // --- section headers --------------------------------------------------------
  const writeSh = (idx: number, name: number, type: number, flags: number, addr: number, off: number, size: number) => {
    const p = shOff + idx * shEntSize;
    u32(p, name);
    u32(p + 4, type);
    if (is64) {
      u64(p + 8, BigInt(flags));
      u64(p + 16, BigInt(addr));
      u64(p + 24, BigInt(off));
      u64(p + 32, BigInt(size));
      u32(p + 40, 0); // sh_link
      u32(p + 44, 0); // sh_info
      u64(p + 48, 0n); // sh_addralign
      u64(p + 56, 0n); // sh_entsize
    } else {
      u32(p + 8, flags);
      u32(p + 12, addr);
      u32(p + 16, off);
      u32(p + 20, size);
      u32(p + 24, 0); // sh_link
      u32(p + 28, 0); // sh_info
      u32(p + 32, 0); // sh_addralign
      u32(p + 36, 0); // sh_entsize
    }
  };

  let secDataOff = ehSize + phNum * phEntSize;
  writeSh(0, 0, 0, 0, 0, 0, 0); // null section
  for (let i = 0; i < sections.length; i++) {
    const sec = sections[i]!;
    const hasData = sec.type !== 8 && sec.content.length > 0;
    if (hasData) secDataOff = (secDataOff + 3) & ~3;
    writeSh(
      i + 1,
      nameOffsets[i]!,
      sec.type,
      sec.flags,
      sec.addr,
      hasData ? secDataOff : 0,
      sec.type === 8 ? sec.content.length : hasData ? sec.content.length : 0,
    );
    if (hasData) secDataOff += sec.content.length;
  }
  // .shstrtab header
  writeSh(shstrIdx, nameOffsets[sections.length]!, 3, 0, 0, shstrOffset, shstr.length);

  return out;
}

/** A convenience: ELF with a .noload section holding format/tag strings. */
export function buildNoloadElf(
  formats: string[],
  tags: string[],
  bits: 32 | 64 = 32,
  littleEndian = true,
  baseAddr = 0x40000000,
): Uint8Array {
  const content: number[] = [];
  const addresses: number[] = [];
  for (const s of [...formats, ...tags]) {
    addresses.push(baseAddr + content.length);
    content.push(...new TextEncoder().encode(s), 0);
  }
  return buildTestElf({
    bits,
    littleEndian,
    machine: 0,
    sections: [
      {
        name: ".noload_keep_in_elf.0",
        type: 1,
        flags: 2, // SHF_ALLOC (but not in any PT_LOAD)
        addr: baseAddr,
        content: Uint8Array.from(content),
      },
    ],
  });
}
