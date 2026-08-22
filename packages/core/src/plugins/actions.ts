/**
 * Action → DeviceCommand validation (§5, stage 3).
 *
 * Actions are the user-facing operations a plugin declares; they ride the
 * EXISTING durable command queue — no second downlink envelope, no new
 * MQTT topic.
 *
 * Trust boundary (review fix): the manifest's `wire.encode` is PLUGIN CODE
 * and executes ONLY inside the Plugin Host container, reached through the
 * dispatcher's supervised oRPC/WebSocket channel (`action.encode`). This module
 * never calls it — it validates the host's ENCODED OUTPUT before anything
 * reaches the command queue:
 *   1. structurally here (single-key scalar maps, bounded count),
 *   2. authoritatively by the core `DeviceCommandSchema` (the same zod
 *      contract the generic command API enforces).
 */

import type { DeviceCommand } from "../protocol/command";
import { DeviceCommandSchema } from "../protocol/command";
import { PluginSystemError } from "./errors";
import type {
  ActionDescriptor,
  CommandArgument,
  PluginManifest,
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

/**
 * Validates a host-returned encoding ({cmd, args}) against the declared
 * action and produces a DeviceCommand ready for the command queue.
 *
 * @throws {PluginSystemError} invalid_action_output.
 */
export function validateEncodedAction(params: {
  action: ActionDescriptor;
  cmd: string;
  args: unknown;
  schemaVersion: number;
}): { command: DeviceCommand; schemaVersion: number } {
  const { action } = params;
  if (params.cmd !== action.wire.command) {
    throw new PluginSystemError(
      "invalid_action_output",
      `host encoded "${params.cmd}" but action "${action.id}" declares "${action.wire.command}"`,
    );
  }
  if (params.schemaVersion !== action.wire.schemaVersion) {
    throw new PluginSystemError(
      "invalid_action_output",
      `host encoded action "${action.id}" with schema version ${params.schemaVersion}, expected ${action.wire.schemaVersion}`,
    );
  }
  if (!Array.isArray(params.args) || params.args.length > 256) {
    throw new PluginSystemError(
      "invalid_action_output",
      `action "${action.id}" encoding returned no array or too many arguments`,
    );
  }
  params.args.forEach(checkEncodedArg);
  const parsed = DeviceCommandSchema.safeParse({
    cmd: params.cmd,
    args: params.args as CommandArgument[],
  });
  if (!parsed.success) {
    throw new PluginSystemError(
      "invalid_action_output",
      `action "${action.id}" produced an invalid DeviceCommand: ${parsed.error.issues[0]?.message ?? "unknown"}`,
    );
  }
  return { command: parsed.data, schemaVersion: action.wire.schemaVersion };
}
