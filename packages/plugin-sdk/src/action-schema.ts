/**
 * Flat action-input schema language (§5, stage 3).
 *
 * The SAME declaration drives both sides of an action:
 *   - `validateActionInput` rejects malformed user input before the wire
 *     encoder runs (the API is the authority; plugins may pre-check);
 *   - the web console renders one form field per entry — no plugin
 *     front-end code is executed for declarative actions (§7.1).
 *
 * Deliberately NOT JSON Schema: a handful of form-expressible rules keeps
 * manifests readable and avoids pulling a validator dependency into every
 * process that touches manifests.
 */

import type {
  ActionDescriptor,
  ActionInputField,
  ActionInputSchema,
} from "./types";

export type { ActionInputField, ActionInputSchema };

export interface InputCheckFailure {
  field: string;
  error: string;
}

export type InputCheck =
  | { ok: true }
  | { ok: false; failures: InputCheckFailure[] };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Validates user-supplied action input against its declared schema. */
export function validateActionInput(
  schema: ActionInputSchema,
  input: unknown,
): InputCheck {
  if (!isPlainObject(input)) {
    return {
      ok: false,
      failures: [{ field: "(root)", error: "input must be an object" }],
    };
  }
  const failures: InputCheckFailure[] = [];
  for (const [name, field] of Object.entries(schema)) {
    const value = input[name];
    if (value === undefined || value === null) {
      if (field.required) {
        failures.push({ field: name, error: "is required" });
      }
      continue;
    }
    switch (field.type) {
      case "string":
        if (typeof value !== "string") {
          failures.push({ field: name, error: "must be a string" });
          continue;
        }
        if (field.enum && !field.enum.includes(value)) {
          failures.push({
            field: name,
            error: `must be one of: ${field.enum.join(", ")}`,
          });
          continue;
        }
        break;
      case "boolean":
        if (typeof value !== "boolean") {
          failures.push({ field: name, error: "must be a boolean" });
          continue;
        }
        break;
      case "integer":
      case "number": {
        if (typeof value !== "number" || !Number.isFinite(value)) {
          failures.push({ field: name, error: "must be a finite number" });
          continue;
        }
        if (field.type === "integer" && !Number.isSafeInteger(value)) {
          failures.push({ field: name, error: "must be an integer" });
          continue;
        }
        if (field.min !== undefined && value < field.min) {
          failures.push({ field: name, error: `must be >= ${field.min}` });
          continue;
        }
        if (field.max !== undefined && value > field.max) {
          failures.push({ field: name, error: `must be <= ${field.max}` });
          continue;
        }
        break;
      }
    }
  }
  const declared = new Set(Object.keys(schema));
  for (const name of Object.keys(input)) {
    if (!declared.has(name)) {
      failures.push({ field: name, error: "is not declared by the action schema" });
    }
  }
  return failures.length === 0 ? { ok: true } : { ok: false, failures };
}

/**
 * Runtime check that a manifest's declared input schema is well-formed
 * (registration-time fail-fast, same spirit as `validatePluginManifest`).
 */
export function validateActionInputSchema(
  action: Pick<ActionDescriptor, "id" | "inputSchema">,
): string | null {
  for (const [name, field] of Object.entries(action.inputSchema)) {
    if (!field || typeof field !== "object" || Array.isArray(field)) {
      return `action "${action.id}" field "${name}" must be an object`;
    }
    if (!["string", "number", "integer", "boolean"].includes(field.type)) {
      return `action "${action.id}" field "${name}" has unsupported type "${String(field.type)}"`;
    }
    if (field.enum !== undefined) {
      if (
        field.type !== "string" ||
        !Array.isArray(field.enum) ||
        field.enum.length === 0 ||
        !field.enum.every((v) => typeof v === "string" && v.length > 0)
      ) {
        return `action "${action.id}" field "${name}" enum must be a non-empty string array on a string field`;
      }
    }
    if (
      (field.min !== undefined || field.max !== undefined) &&
      field.type !== "number" &&
      field.type !== "integer"
    ) {
      return `action "${action.id}" field "${name}" bounds require a numeric type`;
    }
    if (
      field.min !== undefined &&
      field.max !== undefined &&
      field.min > field.max
    ) {
      return `action "${action.id}" field "${name}" min exceeds max`;
    }
  }
  return null;
}
