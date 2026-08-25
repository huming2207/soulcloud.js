import { createHash } from "node:crypto";

export const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;
export type DebugArtifactKind = "elf" | "firmware";

export interface ValidatedArtifact {
  kind: DebugArtifactKind;
  filename: string;
  contentType: string;
  bytes: Uint8Array;
  size: number;
  sha256: string;
  metadata: Record<string, string | number>;
}

export class ArtifactValidationError extends Error {
  /** Stable boundary code consumed by the generic plugin runtime. */
  readonly code = "INVALID_ARTIFACT_INPUT" as const;

  constructor(message: string) {
    super(message);
    this.name = "ArtifactValidationError";
  }
}

function validateFilename(filename: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(filename)) {
    throw new ArtifactValidationError("filename must be a simple name without path separators");
  }
  return filename;
}

function isElfMagic(bytes: Uint8Array): boolean {
  return bytes.byteLength >= 4 && bytes[0] === 0x7f && bytes[1] === 0x45 && bytes[2] === 0x4c && bytes[3] === 0x46;
}

const ELF_HEADER32_BYTES = 52;
const ELF_HEADER64_BYTES = 64;
const ELF_CLASS_32 = 1;
const ELF_CLASS_64 = 2;
const ELF_DATA_LITTLE = 1;
const ELF_DATA_BIG = 2;

const ELF_MACHINE_NAMES: Readonly<Record<number, string>> = {
  3: "x86",
  8: "mips",
  20: "powerpc",
  21: "powerpc64",
  40: "arm",
  62: "x86_64",
  183: "aarch64",
  243: "riscv",
};

interface ElfHeader {
  className: "ELF32" | "ELF64";
  endianness: "little" | "big";
  machine: number;
  entryAddress: string;
  programHeaderOffset: string;
  sectionHeaderOffset: string;
  programHeaderCount: number;
  sectionHeaderCount: number;
  flags: number;
}

function hex(value: bigint): string {
  return `0x${value.toString(16)}`;
}

function parseElfHeader(bytes: Uint8Array): ElfHeader {
  if (!isElfMagic(bytes)) throw new ArtifactValidationError("ELF artifacts must start with the ELF magic");
  if (bytes.byteLength < 16) throw new ArtifactValidationError("ELF identification header is truncated");
  const elfClass = bytes[4];
  const dataEncoding = bytes[5];
  if (elfClass !== ELF_CLASS_32 && elfClass !== ELF_CLASS_64) throw new ArtifactValidationError("ELF class is unsupported");
  if (dataEncoding !== ELF_DATA_LITTLE && dataEncoding !== ELF_DATA_BIG) throw new ArtifactValidationError("ELF byte order is unsupported");
  if (bytes[6] !== 1) throw new ArtifactValidationError("ELF identification version is unsupported");
  const headerBytes = elfClass === ELF_CLASS_32 ? ELF_HEADER32_BYTES : ELF_HEADER64_BYTES;
  if (bytes.byteLength < headerBytes) throw new ArtifactValidationError("ELF header is truncated");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const littleEndian = dataEncoding === ELF_DATA_LITTLE;
  const u16 = (offset: number): number => view.getUint16(offset, littleEndian);
  const u32 = (offset: number): number => view.getUint32(offset, littleEndian);
  const u64 = (offset: number): bigint => view.getBigUint64(offset, littleEndian);
  const machine = u16(18);
  const entryAddress = elfClass === ELF_CLASS_32 ? BigInt(u32(24)) : u64(24);
  const programHeaderOffset = elfClass === ELF_CLASS_32 ? BigInt(u32(28)) : u64(32);
  const sectionHeaderOffset = elfClass === ELF_CLASS_32 ? BigInt(u32(32)) : u64(40);
  const flags = elfClass === ELF_CLASS_32 ? u32(36) : u32(48);
  const entrySize = elfClass === ELF_CLASS_32 ? u16(42) : u16(54);
  const programHeaderCount = elfClass === ELF_CLASS_32 ? u16(44) : u16(56);
  const sectionEntrySize = elfClass === ELF_CLASS_32 ? u16(46) : u16(58);
  const sectionHeaderCount = elfClass === ELF_CLASS_32 ? u16(48) : u16(60);
  if (u16(40 + (elfClass === ELF_CLASS_32 ? 0 : 12)) < headerBytes) throw new ArtifactValidationError("ELF header size is invalid");
  if (programHeaderCount > 0 && (entrySize === 0 || !elfTableFits(programHeaderOffset, entrySize, programHeaderCount, bytes.byteLength))) {
    throw new ArtifactValidationError("ELF program header table is outside the artifact");
  }
  if (sectionHeaderCount > 0 && (sectionEntrySize === 0 || !elfTableFits(sectionHeaderOffset, sectionEntrySize, sectionHeaderCount, bytes.byteLength))) {
    throw new ArtifactValidationError("ELF section header table is outside the artifact");
  }
  return {
    className: elfClass === ELF_CLASS_32 ? "ELF32" : "ELF64",
    endianness: littleEndian ? "little" : "big",
    machine,
    entryAddress: hex(entryAddress),
    programHeaderOffset: hex(programHeaderOffset),
    sectionHeaderOffset: hex(sectionHeaderOffset),
    programHeaderCount,
    sectionHeaderCount,
    flags,
  };
}

function elfTableFits(offset: bigint, entrySize: number, count: number, length: number): boolean {
  if (offset < 0n) return false;
  return offset + BigInt(entrySize) * BigInt(count) <= BigInt(length);
}

/** Validate the first-release artifact envelope without copying its bytes. */
export function validateArtifact(input: {
  kind: DebugArtifactKind;
  filename: string;
  contentType?: string;
  bytes: Uint8Array;
}): ValidatedArtifact {
  if (input.bytes.byteLength === 0) throw new ArtifactValidationError("artifact must not be empty");
  if (input.bytes.byteLength > MAX_ARTIFACT_BYTES) throw new ArtifactValidationError(`artifact exceeds ${MAX_ARTIFACT_BYTES} bytes`);
  const metadata = input.kind === "elf"
    ? (() => {
        const header = parseElfHeader(input.bytes);
        return {
          format: "elf",
          elfClass: header.className,
          endianness: header.endianness,
          machine: header.machine,
          machineName: ELF_MACHINE_NAMES[header.machine] ?? `machine-${header.machine}`,
          entryAddress: header.entryAddress,
          programHeaderOffset: header.programHeaderOffset,
          sectionHeaderOffset: header.sectionHeaderOffset,
          programHeaderCount: header.programHeaderCount,
          sectionHeaderCount: header.sectionHeaderCount,
          flags: header.flags,
        } satisfies Record<string, string | number>;
      })()
    : { format: "raw-firmware" };
  const filename = validateFilename(input.filename);
  const contentType = input.contentType?.trim() || (input.kind === "elf" ? "application/x-elf" : "application/octet-stream");
  if (contentType.length > 128 || /[\r\n]/.test(contentType)) throw new ArtifactValidationError("invalid artifact content type");
  const sha256 = createHash("sha256").update(input.bytes).digest("hex");
  return { kind: input.kind, filename, contentType, bytes: input.bytes, size: input.bytes.byteLength, sha256, metadata };
}
