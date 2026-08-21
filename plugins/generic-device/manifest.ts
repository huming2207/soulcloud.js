import { definePlugin } from "@soulcloud/plugin-sdk";

export const GENERIC_PLUGIN_ID = "soulcloud.generic";
export const GENERIC_PROFILE_ID = "generic";
export const GENERIC_PROFILE_VERSION = 1;

/** Pure metadata; safe to import from trusted core processes. */
export const genericDevicePlugin = definePlugin({
  id: GENERIC_PLUGIN_ID,
  version: "1.0.0",
  apiVersion: 1,
  displayName: "Generic device (builtin)",
  profiles: [
    {
      id: GENERIC_PROFILE_ID,
      version: GENERIC_PROFILE_VERSION,
      manufacturer: "Soulcloud",
      model: "Generic MQTT device",
      capabilities: ["command", "log", "stat", "ota"],
      entities: [],
    },
  ],
  actions: [],
  events: [],
  workflows: [],
  ui: {},
});
