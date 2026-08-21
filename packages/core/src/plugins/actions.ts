/**
 * Action → DeviceCommand encoding (§5, stage 3).
 *
 * Actions are the user-facing operations a plugin declares; they ride the
 * EXISTING durable command queue — no second downlink envelope, no new
 * MQTT topic. The manifest's pure `wire.encode` runs in the API process
 * (manifests are metadata + pure functions; worker code is never imported
 * there), and its output is validated twice:
 *   1. structurally here (single-key scalar maps),
 *   2. authoritatively by the core `DeviceCommandSchema` (the same zod
 *      contract the generic command API enforces).
 */

import type { DeviceCommand } from "../protocol/command";
import { DeviceCommandSchema } from "../protocol/command";
import { PluginSystemError } from "./errors";
import {
  validateActionInput,
  type ActionDescriptor,
  type CommandArgument,
  type PluginManifest,
} from "@soulcloud/plugin-sdk";

export function findAction(
  manifest: PluginManifest,
  actionId: string,
): ActionDescriptor | null {
  return manifest.actions.find((a) => a.id === actionId) ?? null;
}

function checkEncodedArg(arg: unknown, index: number): void {
  if (!arg || typeof arg !== "object" || Array.isArray(arg)) {
    throw new PluginSystemError(
      "invalid_action_output",
      `encoder argument #${index} must be an object`,
    );
  }
  const keys = Object.keys(arg);
  if (keys.length !== 1) {
    throw new PluginSystemError(
      "invalid_action_output",
      `encoder argument #${index} must contain exactly one key`,
    );
  }
  const name = keys[0]!;
  if (name.length === 0 || name.length > 255) {
    throw new PluginSystemError(
      "invalid_action_output",
      `encoder argument #${index} key length is out of range`,
    );
  }
  const value = (arg as Record<string, unknown>)[name];
  const valid =
    typeof value === "string" ||
    typeof value === "boolean" ||
    typeof value === "bigint" ||
    value === null ||
    value instanceof Uint8Array ||
    (typeof value === "number" && Number.isFinite(value));
  if (!valid) {
    throw new PluginSystemError(
      "invalid_action_output",
      `encoder argument "${name}" has a non-scalar value`,
    );
  }
}

export interface EncodedAction {
  /** Ready to enqueue through the existing command queue. */
  command: DeviceCommand;
  /** Declared wire schema version (metadata for audit/UI). */
  schemaVersion: number;
}

/**
 * Validates user input against the action's declared schema and encodes it
 * into a DeviceCommand via the manifest's pure encoder.
 *
 * @throws {PluginSystemError} unknown_action / invalid_action_input /
 * invalid_action_output.
 */
export function encodePluginAction(params: {
  manifest: PluginManifest;
  actionId: string;
  input: unknown;
}): EncodedAction {
  const action = findAction(params.manifest, params.actionId);
  if (!action) {
    throw new PluginSystemError(
      "unknown_action",
      `plugin ${params.manifest.id} does not declare action "${params.actionId}"`,
    );
  }
  const inputCheck = validateActionInput(action.inputSchema, params.input ?? {});
  if (!inputCheck.ok) {
    const detail = inputCheck.failures
      .map((f) => `${f.field} ${f.error}`)
      .join("; ");
    throw new PluginSystemError(
      "invalid_action_input",
      `action "${params.actionId}" input rejected — ${detail}`,
      { failures: inputCheck.failures },
    );
  }
  let encoded: CommandArgument[];
  try {
    encoded = action.wire.encode(params.input ?? {});
  } catch (error) {
    throw new PluginSystemError(
      "invalid_action_output",
      `action "${params.actionId}" encoder threw: ${(error as Error).message}`,
    );
  }
  if (!Array.isArray(encoded) || encoded.length > 256) {
    throw new PluginSystemError(
      "invalid_action_output",
      `action "${params.actionId}" encoder returned no array or too many arguments`,
    );
  }
  encoded.forEach(checkEncodedArg);
  const parsed = DeviceCommandSchema.safeParse({
    cmd: action.wire.command,
    args: encoded,
  });
  if (!parsed.success) {
    throw new PluginSystemError(
      "invalid_action_output",
      `action "${params.actionId}" produced an invalid DeviceCommand: ${parsed.error.issues[0]?.message ?? "unknown"}`,
    );
  }
  return { command: parsed.data, schemaVersion: action.wire.schemaVersion };
}
