/**
 * Trusted-side registry. This module imports manifest-only modules. It must
 * never import a worker module: importing it from API/Dispatcher must not
 * execute plugin runtime code.
 */

import type { PluginManifest, PluginWorker } from "@soulcloud/plugin-sdk";
import {
  genericDevicePlugin,
  GENERIC_PLUGIN_ID,
  GENERIC_PROFILE_ID,
  GENERIC_PROFILE_VERSION,
} from "./generic-device/manifest";
import {
  chaosTestPlugin,
  CHAOS_PLUGIN_ID,
  CHAOS_PROFILE_ID,
  CHAOS_PROFILE_VERSION,
} from "./chaos-test/manifest";

export const pluginManifests: ReadonlyMap<string, PluginManifest> = new Map([
  [genericDevicePlugin.id, genericDevicePlugin],
  [chaosTestPlugin.id, chaosTestPlugin],
]);

/**
 * Worker loaders are lazy. Only plugin-host may import this module, and it
 * evaluates the requested worker module after the host container starts.
 */
export type PluginWorkerLoader = () => Promise<PluginWorker>;

export const pluginWorkerLoaders: ReadonlyMap<string, PluginWorkerLoader> =
  new Map([
    [
      GENERIC_PLUGIN_ID,
      async () => (await import("./generic-device/worker")).genericDeviceWorker,
    ],
    [
      CHAOS_PLUGIN_ID,
      async () => (await import("./chaos-test/worker")).chaosTestWorker,
    ],
  ]);

export {
  GENERIC_PLUGIN_ID,
  GENERIC_PROFILE_ID,
  GENERIC_PROFILE_VERSION,
  genericDevicePlugin,
} from "./generic-device/manifest";
export {
  CHAOS_PLUGIN_ID,
  CHAOS_PROFILE_ID,
  CHAOS_PROFILE_VERSION,
  chaosTestPlugin,
} from "./chaos-test/manifest";
