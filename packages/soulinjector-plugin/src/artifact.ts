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

function isElf(bytes: Uint8Array): boolean {
  return bytes.byteLength >= 4 && bytes[0] === 0x7f && bytes[1] === 0x45 && bytes[2] === 0x4c && bytes[3] === 0x46;
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
  if (input.kind === "elf" && !isElf(input.bytes)) throw new ArtifactValidationError("ELF artifacts must start with the ELF magic");
  const filename = validateFilename(input.filename);
  const contentType = input.contentType?.trim() || (input.kind === "elf" ? "application/x-elf" : "application/octet-stream");
  if (contentType.length > 128 || /[\r\n]/.test(contentType)) throw new ArtifactValidationError("invalid artifact content type");
  const sha256 = createHash("sha256").update(input.bytes).digest("hex");
  return { kind: input.kind, filename, contentType, bytes: input.bytes, size: input.bytes.byteLength, sha256 };
}
