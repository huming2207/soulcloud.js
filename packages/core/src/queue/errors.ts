/**
 * Typed errors for the durable device-command queue.
 *
 * The `kind` discriminator lets API layers map errors to HTTP status codes
 * without inspecting messages, mirroring the Rust CommandQueueError enum.
 */

export type CommandQueueErrorKind =
  | "empty_targets"
  | "duplicate_targets"
  | "too_many_targets"
  | "missing_targets"
  | "invalid_device_uid"
  | "invalid_provenance"
  | "invalid_sequence"
  | "lease_time_overflow"
  | "lease_conflict"
  | "result_mismatch"
  | "conflicting_result"
  | "invalid_stored_result"
  | "missing_stored_result"
  | "database";

export class CommandQueueError extends Error {
  constructor(
    public readonly kind: CommandQueueErrorKind,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "CommandQueueError";
  }
}
