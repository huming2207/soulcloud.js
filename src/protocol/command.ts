/**
 * MessagePack payloads for platform-to-device generic MQTT commands
 * (`cmd/exec`) and device-to-platform terminal results (`cmd/result`).
 *
 * Wire contract (must stay in sync with the Rust soulcloud-core codec):
 *   - exactly one complete MessagePack value, no trailing bytes
 *   - no duplicate / unknown / missing / null-required fields
 *   - `id`: exactly 16 MessagePack binary bytes (the per-device command UUID)
 *   - `seq`: unsigned 64-bit, monotonically increasing per device
 *   - `code`: signed 32-bit C-style result code
 *   - `args` / `payload`: array of maps with exactly one string key each;
 *     values are only nil, string, binary, int, float, boolean; binary must
 *     use the MessagePack `bin` type (not a byte array); nested arrays/maps
 *     and extensions are rejected.
 */

import { encode as msgpackEncode, decode as msgpackDecode } from "@msgpack/msgpack";
import { z } from "zod";
import { MessagePackStructureError, validateMessagePackStructure } from "./structure";

const UINT64_MAX = (1n << 64n) - 1n;
const INT32_MIN = -(2 ** 31);
const INT32_MAX = 2 ** 31 - 1;

/**
 * A 16-byte binary command ID. `id` must be MessagePack `bin`, which
 * @msgpack/msgpack decodes to Uint8Array (a byte array decodes to a plain
 * Array and a string to a string, both rejected here).
 */
const CommandIdSchema = z
  .instanceof(Uint8Array)
  .refine((v) => v.length === 16, { message: "command ID must be exactly 16 bytes" });

/** An unsigned 64-bit sequence. Small values decode as number, large as bigint. */
const SequenceSchema = z
  .union([z.bigint(), z.number().int().min(0)])
  .transform((v) => (typeof v === "number" ? BigInt(v) : v))
  .refine((v) => v <= UINT64_MAX, { message: "sequence must be an unsigned 64-bit integer" });

/** A scalar value permitted in a command argument or result payload. */
export const CommandArgumentValueSchema = z.union([
  z.null(),
  z.string(),
  z.instanceof(Uint8Array),
  z.bigint(),
  z.number(),
  z.boolean(),
]);

/** One named argument: a map with exactly one string key. */
export const CommandArgumentSchema = z
  .record(z.string(), CommandArgumentValueSchema)
  .refine((obj) => Object.keys(obj).length === 1, {
    message: "a command argument must contain exactly one key-value pair",
  });

/** Command arguments may be omitted or MessagePack nil (both mean "none"). */
const ArgumentsSchema = z
  .array(CommandArgumentSchema)
  .nullable()
  .optional()
  .transform((v) => v ?? undefined);

/** The command name and optional arguments accepted by the human API. */
export const DeviceCommandSchema = z
  .object({
    cmd: z.string().min(1),
    args: z.array(CommandArgumentSchema).optional(),
  })
  .strict();

/** A command execution published to a device's `cmd/exec` topic. */
export const DeviceCommandExecutionSchema = z
  .object({
    id: CommandIdSchema,
    seq: SequenceSchema,
    cmd: z.string().min(1),
    args: ArgumentsSchema,
  })
  .strict();

/** A terminal execution result published by a device to `cmd/result`. */
export const DeviceCommandResultSchema = z
  .object({
    id: CommandIdSchema,
    seq: SequenceSchema,
    code: z.number().int().min(INT32_MIN).max(INT32_MAX),
    payload: ArgumentsSchema,
  })
  .strict();

export type CommandArgumentValue = z.infer<typeof CommandArgumentValueSchema>;
export type CommandArgument = z.infer<typeof CommandArgumentSchema>;
export type DeviceCommand = z.infer<typeof DeviceCommandSchema>;
export type DeviceCommandExecution = z.infer<typeof DeviceCommandExecutionSchema>;
export type DeviceCommandResult = z.infer<typeof DeviceCommandResultSchema>;

// --- Error type -------------------------------------------------------------

export class CommandPayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CommandPayloadError";
  }
}

// --- Decoding ---------------------------------------------------------------

function decodeExact<T>(
  payload: Uint8Array,
  schema: z.ZodType<T>,
  what: string,
): T {
  try {
    validateMessagePackStructure(payload);
  } catch (error) {
    if (error instanceof MessagePackStructureError) {
      throw new CommandPayloadError(
        `invalid ${what} MessagePack payload: ${error.message}`,
      );
    }
    throw error;
  }
  let value: unknown;
  try {
    // useBigInt64: 64-bit ints decode as bigint (no precision loss); 32-bit
    // ints (e.g. `code`) remain numbers.
    value = msgpackDecode(payload, { useBigInt64: true });
  } catch (error) {
    throw new CommandPayloadError(
      `invalid ${what} MessagePack payload: ${(error as Error).message}`,
    );
  }
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new CommandPayloadError(
      `invalid ${what} payload: ${result.error.issues
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; ")}`,
    );
  }
  return result.data;
}

/**
 * Decodes a command execution from a `cmd/exec` payload.
 *
 * @throws {CommandPayloadError} unless the payload is a map with a 16-byte
 * binary `id`, unsigned `seq`, non-null `cmd` string and optional/null `args`.
 */
export function decodeDeviceCommandExecution(
  payload: Uint8Array,
): DeviceCommandExecution {
  return decodeExact(payload, DeviceCommandExecutionSchema, "command execution");
}

/**
 * Decodes a terminal command result from a `cmd/result` payload.
 *
 * @throws {CommandPayloadError} unless the payload is a map with a 16-byte
 * binary `id`, unsigned `seq`, signed 32-bit `code` and optional/null `payload`.
 */
export function decodeDeviceCommandResult(payload: Uint8Array): DeviceCommandResult {
  return decodeExact(payload, DeviceCommandResultSchema, "command result");
}

// --- Encoding ---------------------------------------------------------------

/**
 * Encodes a command execution for a device `cmd/exec` topic.
 *
 * `args` omitted or nil are both encoded as MessagePack nil, matching the
 * Rust codec output byte-for-byte.
 */
export function encodeDeviceCommandExecution(
  command: DeviceCommandExecution,
): Uint8Array {
  return msgpackEncode(
    { ...command, args: command.args ?? null },
    { useBigInt64: true },
  );
}

/**
 * Encodes a command name and optional arguments (the human-API command body,
 * without the execution envelope). Omitted args are encoded as nil.
 */
export function encodeDeviceCommand(command: DeviceCommand): Uint8Array {
  return msgpackEncode(
    { ...command, args: command.args ?? null },
    { useBigInt64: true },
  );
}

/**
 * Encodes a terminal command result for a device `cmd/result` topic.
 * Omitted payload is encoded as nil, matching the Rust codec output.
 */
export function encodeDeviceCommandResult(result: DeviceCommandResult): Uint8Array {
  return msgpackEncode(
    { ...result, payload: result.payload ?? null },
    { useBigInt64: true },
  );
}
