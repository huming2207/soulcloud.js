/**
 * `definePlugin` — the compile-time registration entry point (§2).
 *
 * Plugins are trusted-team code compiled into the deployment. Definition
 * validates the manifest eagerly so a malformed plugin fails the build/boot
 * instead of surfacing as a routing surprise in production.
 */

import { validatePluginManifest } from "./validation";
import type { PluginManifest, PluginWorker } from "./types";
import type { PluginManifestInput } from "./validation";

export interface PluginDefinition {
  manifest: PluginManifest;
}

/**
 * Identity function that validates the manifest at module load. The worker
 * is deliberately NOT part of the definition: core services (API,
 * dispatcher) must only ever import manifest data, never plugin runtime
 * code — the registry keeps the two sides separable.
 */
export function definePlugin(manifest: PluginManifestInput): PluginManifest {
  const result = validatePluginManifest(manifest);
  if (!result.ok) {
    throw new Error(`definePlugin: ${result.error}`);
  }
  return result.manifest;
}

/** Convenience pair for registry entries. */
export function definePluginEntry(
  manifest: PluginManifestInput,
  worker: PluginWorker,
): { manifest: PluginManifest; worker: PluginWorker } {
  return { manifest: definePlugin(manifest), worker };
}
