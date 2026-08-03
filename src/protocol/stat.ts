/**
 * MessagePack payloads for device-to-platform status MQTT messages (`stat`).
 *
 * Wire contract (must stay in sync with the Rust soulcloud-core codec):
 *   - exactly one complete MessagePack value, no trailing bytes
 *   - top-level map with exactly the four required fields `sn`, `fw`, `up`,
 *     `rst`; missing / null / duplicate / unknown / wrongly typed fields are
 *     rejected
 *   - `sn` / `fw`: MessagePack binary values
 *   - `up`: unsigned 64-bit uptime counter
 *   - `rst`: non-null string reset reason
 */

import { encode as msgpackEncode, decode as msgpackDecode } from "@msgpack/msgpack";
import { z } from "zod";
import { MessagePackStructureError, validateMessagePackStructure } from "./structure";

const UINT64_MAX = (1n << 64n) - 1n;

/** Binary values (`sn`, `fw`). Must be MessagePack `bin`, decoded as Uint8Array. */
const BinarySchema = z.instanceof(Uint8Array);

/** An unsigned 64-bit uptime counter. */
const UptimeSchema = z
  .union([z.bigint(), z.number().int().min(0)])
  .transform((v) => (typeof v === "number" ? BigInt(v) : v))
  .refine((v) => v <= UINT64_MAX, { message: "uptime must be an unsigned 64-bit integer" });

export const DeviceStatSchema = z
  .object({
    sn: BinarySchema,
    fw: BinarySchema,
    up: UptimeSchema,
    rst: z.string().min(1),
  })
  .strict();

export type DeviceStat = z.infer<typeof DeviceStatSchema>;

// --- Error type -------------------------------------------------------------

export class DeviceStatPayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeviceStatPayloadError";
  }
}

/**
 * Decodes a device status report from a `stat` topic payload.
 *
 * @throws {DeviceStatPayloadError} unless the payload is a map containing
 * non-null binary `sn` and `fw`, an unsigned 64-bit `up` and a non-null
 * string `rst`.
 */
export function decodeDeviceStat(payload: Uint8Array): DeviceStat {
  try {
    validateMessagePackStructure(payload);
  } catch (error) {
    if (error instanceof MessagePackStructureError) {
      throw new DeviceStatPayloadError(
        `invalid device status MessagePack payload: ${error.message}`,
      );
    }
    throw error;
  }
  let value: unknown;
  try {
    value = msgpackDecode(payload, { useBigInt64: true });
  } catch (error) {
    throw new DeviceStatPayloadError(
      `invalid device status MessagePack payload: ${(error as Error).message}`,
    );
  }
  const result = DeviceStatSchema.safeParse(value);
  if (!result.success) {
    throw new DeviceStatPayloadError(
      `invalid device status payload: ${result.error.issues
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; ")}`,
    );
  }
  return result.data;
}

/**
 * Encodes a device status report as a MessagePack map for a `stat` topic.
 */
export function encodeDeviceStat(stat: DeviceStat): Uint8Array {
  return msgpackEncode(stat, { useBigInt64: true });
}
