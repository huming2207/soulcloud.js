/**
 * Device-to-platform OTA result protocol: strict MessagePack decoding of
 * `ota/result` payloads (same discipline as cmd/result and stat: structure
 * pre-check, bounded decode, Zod schema, no trailing bytes).
 */

import { z } from "zod";
import { decode as msgpackDecode } from "@msgpack/msgpack";
import { MessagePackStructureError, validateMessagePackStructure } from "./structure";

/** Maximum message length (debug text only). */
export const MAX_OTA_RESULT_MESSAGE = 512;

export const OtaResultSchema = z
  .object({
    release_id: z.string().uuid(),
    job_id: z.string().uuid(),
    state: z.enum(["downloaded", "installed", "failed"]),
    code: z.number().int(),
    message: z.string().max(MAX_OTA_RESULT_MESSAGE).optional(),
  })
  .strict(); // unknown keys are rejected

export type OtaResultPayload = z.infer<typeof OtaResultSchema>;

export class OtaResultPayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OtaResultPayloadError";
  }
}

/**
 * Strictly decodes an ota/result payload.
 *
 * @throws {OtaResultPayloadError} on structural or schema violations.
 */
export function decodeOtaResult(payload: Uint8Array): OtaResultPayload {
  try {
    validateMessagePackStructure(payload);
  } catch (error) {
    if (error instanceof MessagePackStructureError) {
      throw new OtaResultPayloadError(
        `invalid ota result MessagePack payload: ${error.message}`,
      );
    }
    throw error;
  }
  let value: unknown;
  try {
    value = msgpackDecode(payload, { useBigInt64: true });
  } catch (error) {
    throw new OtaResultPayloadError(
      `invalid ota result MessagePack payload: ${(error as Error).message}`,
    );
  }
  const result = OtaResultSchema.safeParse(value);
  if (!result.success) {
    throw new OtaResultPayloadError(
      `invalid ota result payload: ${result.error.issues
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; ")}`,
    );
  }
  return result.data;
}

/**
 * Failure codes (v1 minimal set; the full negative error-number registry
 * is deferred to the command contract milestone).
 */
export const OTA_RESULT_CODES = {
  SUCCESS: 0,
  DOWNLOAD_FAILED: -1,
  CHECKSUM_MISMATCH: -2,
  FLASH_FAILED: -3,
  INVALID_IMAGE: -4,
  OTHER: -5,
} as const;
