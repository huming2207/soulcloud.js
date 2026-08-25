import { validateManifest } from "./validation";
import type { PluginDefinition, PluginManifest } from "./types";

/** Validates plugin metadata at plugin boot; no runtime registry is involved. */
export function definePlugin(definition: PluginDefinition): PluginDefinition {
  const manifest = validateManifest(definition.manifest);
  const actionIds = new Set(manifest.actions.map((action) => action.id));
  const routeIds = new Set(manifest.ui?.routes.map((route) => route.id) ?? []);
  for (const action of manifest.actions) {
    if (typeof definition.encodeAction?.[action.id] !== "function") {
      throw new Error(`plugin action ${action.id} has no encoder`);
    }
  }
  for (const actionId of Object.keys(definition.encodeAction ?? {})) {
    if (!actionIds.has(actionId)) throw new Error(`plugin encoder ${actionId} is not declared in the manifest`);
  }
  if (manifest.events.length > 0 && typeof definition.onEvent !== "function") {
    throw new Error("plugin declares events but has no event handler");
  }
  for (const route of manifest.ui?.routes ?? []) {
    if (typeof definition.render?.[route.id] !== "function") {
      throw new Error(`plugin UI route ${route.id} has no renderer`);
    }
    if ((route.methods ?? ["GET"]).includes("POST") && typeof definition.handleAction?.[route.id] !== "function") {
      throw new Error(`plugin UI route ${route.id} accepts POST but has no action handler`);
    }
  }
  for (const routeId of Object.keys(definition.render ?? {})) {
    if (!routeIds.has(routeId)) throw new Error(`plugin renderer ${routeId} is not declared in the manifest`);
  }
  for (const routeId of Object.keys(definition.handleAction ?? {})) {
    if (!routeIds.has(routeId)) throw new Error(`plugin UI action ${routeId} is not declared in the manifest`);
  }
  const assetPaths = new Set(manifest.ui?.assets?.map((asset) => asset.path) ?? []);
  for (const assetPath of Object.keys(definition.assets ?? {})) {
    if (!assetPaths.has(assetPath)) throw new Error(`plugin asset ${assetPath} is not declared in the manifest`);
  }
  for (const asset of manifest.ui?.assets ?? []) {
    if (typeof definition.assets?.[asset.path] !== "function") throw new Error(`plugin UI asset ${asset.path} has no renderer`);
  }
  return { ...definition, manifest };
}

export function defineManifest(manifest: PluginManifest): PluginManifest {
  return validateManifest(manifest);
}
