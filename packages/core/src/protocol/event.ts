/**
 * MessagePack payload for the generic Soulcloud Device `/event` topic.
 *
 * The broker validates only this envelope. `data` remains plugin-owned and is
 * stored as the original MessagePack payload; the broker never interprets it.
 * The envelope is deliberately small and stable so devices can implement it
 * without a plugin runtime or a second connection.
 */

import { decode as msgpackDecode, encode as msgpackEncode } from "@msgpack/msgpack";
import { z } from "zod";
import { MessagePackStructureError, validateMessagePackStructure } from "./structure";

const UINT64_MAX = (1n << 64n) - 1n;
const MAX_EVENT_ID_BYTES = 16;
const MAX_EVENT_KIND_BYTES = 128;
const MAX_EVENT_SCHEMA = 0x7fffffff;

const EventIdSchema = z
  .instanceof(Uint8Array)
  .refine((value) => value.length === MAX_EVENT_ID_BYTES, {
    message: `event id must be exactly ${MAX_EVENT_ID_BYTES} bytes`,
  });

const EventSequenceSchema = z
  .union([z.bigint(), z.number().int().nonnegative()])
  .transform((value) => (typeof value === "number" ? BigInt(value) : value))
  .refine((value) => value <= UINT64_MAX, {
    message: "event sequence must be an unsigned 64-bit integer",
  });

export const DeviceEventEnvelopeSchema = z
  .object({
    id: EventIdSchema,
    seq: EventSequenceSchema,
    kind: z
      .string()
      .min(1)
      .refine((value) => Buffer.byteLength(value) <= MAX_EVENT_KIND_BYTES, {
        message: `event kind must be at most ${MAX_EVENT_KIND_BYTES} UTF-8 bytes`,
      }),
    schema: z.number().int().positive().max(MAX_EVENT_SCHEMA),
    data: z.unknown().refine((value) => value !== undefined, {
      message: "event data must be present",
    }),
  })
  .strict();

export type DeviceEventEnvelope = z.infer<typeof DeviceEventEnvelopeSchema>;

export class DeviceEventPayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeviceEventPayloadError";
  }
}

/** Decodes and validates exactly one generic device event envelope. */
export function decodeDeviceEvent(payload: Uint8Array): DeviceEventEnvelope {
  try {
    validateMessagePackStructure(payload);
  } catch (error) {
    if (error instanceof MessagePackStructureError) {
      throw new DeviceEventPayloadError(
        `invalid device event MessagePack payload: ${error.message}`,
      );
    }
    throw error;
  }

  let value: unknown;
  try {
    value = msgpackDecode(payload, { useBigInt64: true });
  } catch (error) {
    throw new DeviceEventPayloadError(
      `invalid device event MessagePack payload: ${(error as Error).message}`,
    );
  }

  const result = DeviceEventEnvelopeSchema.safeParse(value);
  if (!result.success) {
    throw new DeviceEventPayloadError(
      `invalid device event payload: ${result.error.issues
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
        .join("; ")}`,
    );
  }
  return result.data;
}

/** Encodes an event envelope for the device `/event` topic. */
export function encodeDeviceEvent(event: DeviceEventEnvelope): Uint8Array {
  const value = DeviceEventEnvelopeSchema.parse(event);
  return msgpackEncode(value, { useBigInt64: true });
}

export const DEVICE_EVENT_ID_BYTES = MAX_EVENT_ID_BYTES;
export const DEVICE_EVENT_KIND_MAX_BYTES = MAX_EVENT_KIND_BYTES;
