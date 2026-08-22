import { validateManifest } from "./validation";
import type { PluginDefinition, PluginManifest } from "./types";

/** Validates plugin metadata at plugin boot; no runtime registry is involved. */
export function definePlugin(definition: PluginDefinition): PluginDefinition {
  const manifest = validateManifest(definition.manifest);
  return { ...definition, manifest };
}

export function defineManifest(manifest: PluginManifest): PluginManifest {
  return validateManifest(manifest);
}
