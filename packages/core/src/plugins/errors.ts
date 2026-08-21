/**
 * Typed errors for the plugin subsystem (installations, entity registry,
 * plugin event queue). Mirrors the CommandQueueError convention: the
 * `kind` discriminator lets callers map to actions without parsing
 * messages.
 */

export type PluginSystemErrorKind =
  | "unknown_plugin"
  | "unknown_profile"
  | "version_mismatch"
  | "invalid_installation"
  | "installation_not_enabled"
  | "device_not_bound"
  | "binding_mismatch"
  | "invalid_event"
  | "unknown_event_kind"
  | "unknown_entity"
  | "invalid_entity_update"
  | "unknown_action"
  | "invalid_action_input"
  | "invalid_action_output"
  | "migration_blocked"
  | "lease_time_overflow"
  | "database";

export class PluginSystemError extends Error {
  constructor(
    public readonly kind: PluginSystemErrorKind,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "PluginSystemError";
  }
}
