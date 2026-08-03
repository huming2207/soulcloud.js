/**
 * Minimal, dependency-free ELF parser for on9log host-side decoding.
 *
 * Purpose: map the 32-bit `tag_id` / `fmt_id` virtual addresses carried in
 * on9log packets back to strings in a firmware ELF:
 *
 *   - format strings live in `.noload_keep_in_elf.*` sections (ELF-only,
 *     never loaded to RAM)
 *   - tags may live in those sections or in ordinary read-only sections
 *
 * Supported: ELF32/ELF64, little/big endian (real-world: ELF32-LE Xtensa
 * ESP32-S3, ELF64-LE Unix host). Safety: pure parsing, no execution; every
 * offset/length is bounds-checked; extraction is limited to recognized
 * sections so unrelated binary data is never scanned as text.
 */

export class ElfParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ElfParseError";
  }
}

export interface ElfSection {
  name: string;
  /** Offset of the section name in the string table (resolved at parse end). */
  nameOffset: number;
  type: number;
  flags: bigint;
  addr: bigint;
  offset: bigint;
  size: bigint;
}

/** A PT_LOAD segment: vaddr -> file offset mapping. */
export interface ElfLoadSegment {
  vaddr: bigint;
  offset: bigint;
  filesz: bigint;
}

export interface ElfInfo {
  /** 32 or 64. */
  bits: 32 | 64;
  /** true = little-endian. */
  littleEndian: boolean;
  machine: number;
  entry: bigint;
  sections: ElfSection[];
  /** PT_LOAD segments (vaddr -> file offset). */
  loads: ElfLoadSegment[];
}

const PT_LOAD = 1;
const SHT_NOBITS = 8;

class ElfReader {
  private readonly view: DataView;
  constructor(
    private readonly buf: Uint8Array,
    public pos: number,
    private readonly le: boolean,
  ) {
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  u8(): number {
    if (this.pos + 1 > this.buf.length) {
      throw new ElfParseError(`truncated ELF at offset ${this.pos}`);
    }
    return this.view.getUint8(this.pos++);
  }

  u16(): number {
    if (this.pos + 2 > this.buf.length) {
      throw new ElfParseError(`truncated ELF at offset ${this.pos}`);
    }
    const v = this.view.getUint16(this.pos, this.le);
    this.pos += 2;
    return v;
  }

  u32(): number {
    if (this.pos + 4 > this.buf.length) {
      throw new ElfParseError(`truncated ELF at offset ${this.pos}`);
    }
    const v = this.view.getUint32(this.pos, this.le);
    this.pos += 4;
    return v >>> 0;
  }

  u64(): bigint {
    if (this.pos + 8 > this.buf.length) {
      throw new ElfParseError(`truncated ELF at offset ${this.pos}`);
    }
    const v = this.view.getBigUint64(this.pos, this.le);
    this.pos += 8;
    return v;
  }

  word(): bigint {
    return this.bits === 64 ? this.u64() : BigInt(this.u32());
  }

  bits: 32 | 64 = 32;
}

/**
 * Parses an ELF file (or its bytes).
 *
 * @throws {ElfParseError} for invalid or truncated ELF data.
 */
export function parseElf(data: Uint8Array): ElfInfo {
  if (data.length < 52) {
    throw new ElfParseError("ELF too short");
  }
  if (
    data[0] !== 0x7f ||
    data[1] !== 0x45 /* E */ ||
    data[2] !== 0x4c /* L */ ||
    data[3] !== 0x46 /* F */
  ) {
    throw new ElfParseError("invalid ELF magic");
  }
  const bits = data[4] === 2 ? 64 : data[4] === 1 ? 32 : null;
  if (bits === null) {
    throw new ElfParseError(`invalid ELF class byte ${data[4]}`);
  }
  const le = data[5] === 1;
  if (data[5] !== 1 && data[5] !== 2) {
    throw new ElfParseError(`invalid ELF data encoding byte ${data[5]}`);
  }

  const reader = new ElfReader(data, 0, le);
  reader.bits = bits;
  reader.u32(); // magic + class + data + version + osabi (16 bytes e_ident)
  reader.pos = 16;
  const elfType = reader.u16();
  const machine = reader.u16();
  reader.u32(); // e_version
  const entry = reader.word();
  const phoff = reader.word();
  const shoff = reader.word();
  reader.u32(); // e_flags
  reader.u16(); // e_ehsize
  const phentsize = reader.u16();
  const phnum = reader.u16();
  const shentsize = reader.u16();
  const shnum = reader.u16();
  const shstrndx = reader.u16();

  if (shnum === 0) {
    throw new ElfParseError("ELF has no section headers");
  }
  if (shentsize < (bits === 64 ? 64 : 40)) {
    throw new ElfParseError(`invalid section header size ${shentsize}`);
  }
  if (phnum > 0 && phentsize < (bits === 64 ? 56 : 32)) {
    throw new ElfParseError(`invalid program header size ${phentsize}`);
  }
  if (elfType !== 2 && elfType !== 3) {
    // accept ET_EXEC and ET_DYN; others are unusual for firmware
  }

  // --- load segments (vaddr -> file offset) --------------------------------

  const loads: ElfLoadSegment[] = [];
  for (let i = 0; i < phnum; i++) {
    const p = Number(phoff) + i * phentsize;
    if (p + phentsize > data.length) {
      throw new ElfParseError("truncated ELF program headers");
    }
    reader.pos = Number(p);
    const pType = reader.u32();
    if (bits === 64) {
      reader.u32(); // p_flags
      const pOffset = reader.word();
      const pVaddr = reader.word();
      reader.word(); // p_paddr
      const pFilesz = reader.word();
      reader.word(); // p_memsz
      if (pType === PT_LOAD) {
        loads.push({ vaddr: pVaddr, offset: pOffset, filesz: pFilesz });
      }
    } else {
      const pOffset = reader.word();
      const pVaddr = reader.word();
      reader.word(); // p_paddr
      const pFilesz = reader.word();
      reader.word(); // p_memsz
      if (pType === PT_LOAD) {
        loads.push({ vaddr: pVaddr, offset: pOffset, filesz: pFilesz });
      }
    }
  }

  // --- section headers ------------------------------------------------------

  const sections: ElfSection[] = [];
  for (let i = 0; i < shnum; i++) {
    const s = Number(shoff) + i * shentsize;
    if (s + shentsize > data.length) {
      throw new ElfParseError("truncated ELF section headers");
    }
    reader.pos = Number(s);
    const shName = reader.u32();
    const shType = reader.u32();
    if (bits === 64) {
      const shFlags = reader.u64();
      const shAddr = reader.word();
      const shOffset = reader.word();
      const shSize = reader.word();
      reader.u32(); // sh_link
      reader.u32(); // sh_info
      reader.word(); // sh_addralign
      reader.word(); // sh_entsize
      sections.push({ name: "", nameOffset: shName, type: shType, flags: shFlags, addr: shAddr, offset: shOffset, size: shSize });
    } else {
      const shFlags = BigInt(reader.u32());
      const shAddr = reader.word();
      const shOffset = reader.word();
      const shSize = reader.word();
      reader.u32(); // sh_link
      reader.u32(); // sh_info
      reader.u32(); // sh_addralign
      reader.u32(); // sh_entsize
      sections.push({ name: "", nameOffset: shName, type: shType, flags: shFlags, addr: shAddr, offset: shOffset, size: shSize });
    }
  }

  // --- section names (via the string table section) --------------------------

  if (shstrndx >= shnum) {
    throw new ElfParseError(`invalid section name string table index ${shstrndx}`);
  }
  const strTab = sections[shstrndx]!;
  for (const sec of sections) {
    sec.name = readCStringAt(data, strTab, sec.nameOffset);
  }

  void elfType; // reserved for future use
  return { bits, littleEndian: le, machine, entry, sections, loads };
}

/** Reads a NUL-terminated string from a section at a relative offset. */
function readCStringAt(data: Uint8Array, sec: ElfSection, relOffset: number): string {
  const start = Number(sec.offset) + relOffset;
  if (sec.type === SHT_NOBITS || start < 0 || start >= data.length) return "";
  let end = start;
  const limit = Math.min(Number(sec.offset) + Number(sec.size), data.length);
  while (end < limit && data[end] !== 0) end++;
  return new TextDecoder().decode(data.subarray(start, end));
}

/** A string found in an ELF section (address + content). */
export interface ElfString {
  /** Virtual address of the string start. */
  addr: number;
  value: string;
}

/**
 * Extracts every NUL-terminated string in the given section.
 * Used for `.noload_keep_in_elf.*` format/tag strings.
 */
export function extractStrings(
  elf: ElfInfo,
  data: Uint8Array,
  sectionName: string,
): ElfString[] {
  const sec = elf.sections.find((s) => s.name === sectionName);
  if (!sec || sec.type === SHT_NOBITS) return [];
  const start = Number(sec.offset);
  const size = Number(sec.size);
  const limit = Math.min(start + size, data.length);
  const out: ElfString[] = [];
  let i = start;
  while (i < limit) {
    // skip padding zeros
    while (i < limit && data[i] === 0) i++;
    if (i >= limit) break;
    const strStart = i;
    while (i < limit && data[i] !== 0) i++;
    if (i >= limit && data[limit - 1] !== 0) {
      // unterminated tail: accept only if the section is exactly at EOF
      if (limit !== data.length) break;
    }
    const value = new TextDecoder().decode(data.subarray(strStart, i));
    if (value.length > 0 && isLikelyText(value)) {
      out.push({ addr: Number(sec.addr) + (strStart - start), value });
    }
  }
  return out;
}

/** Filters out binary garbage while scanning string sections. */
function isLikelyText(s: string): boolean {
  // printable ASCII, plus common UTF-8 sequences; reject control chars
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) {
      return false;
    }
    if (code === 0x7f) return false;
  }
  return true;
}

/**
 * Reads a NUL-terminated string at a virtual address.
 *
 * Resolution order:
 *   1. PT_LOAD segments (the correct mapping for linked binaries)
 *   2. allocated sections (covers `.noload_keep_in_elf.*`, which by design
 *      is not part of any PT_LOAD segment)
 *
 * @returns the string, or null when the address is not mapped or the
 * resulting bytes are not plausible text.
 */
export function readStringAtVaddr(
  elf: ElfInfo,
  data: Uint8Array,
  vaddr: number,
  maxLen = 4096,
): string | null {
  const target = BigInt(vaddr);

  for (const load of elf.loads) {
    if (target >= load.vaddr && target < load.vaddr + load.filesz) {
      return readBounded(data, load.offset + (target - load.vaddr), load.offset + load.filesz, maxLen);
    }
  }
  for (const sec of elf.sections) {
    if (sec.type === SHT_NOBITS || sec.size === 0n) continue;
    if ((sec.flags & 2n) === 0n) continue; // only allocated sections have runtime addresses
    if (target >= sec.addr && target < sec.addr + sec.size) {
      return readBounded(data, sec.offset + (target - sec.addr), sec.offset + sec.size, maxLen);
    }
  }
  return null;
}

function readBounded(
  data: Uint8Array,
  start: bigint,
  limit: bigint,
  maxLen: number,
): string | null {
  const off = Number(start);
  const lim = Math.min(Number(limit), data.length, off + maxLen);
  if (off < 0 || off >= data.length) return null;
  let end = off;
  while (end < lim && data[end] !== 0) end++;
  if (end >= lim && data[lim - 1] !== 0) return null; // unterminated
  const value = new TextDecoder().decode(data.subarray(off, end));
  return isLikelyText(value) ? value : null;
}
