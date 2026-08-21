import { definePlugin } from "@soulcloud/plugin-sdk";

export const CHAOS_PLUGIN_ID = "soulcloud.test.chaos";
export const CHAOS_PROFILE_ID = "chaos_fixture";
export const CHAOS_PROFILE_VERSION = 1;

/** Pure metadata; the worker is intentionally not imported here. */
export const chaosTestPlugin = definePlugin({
  id: CHAOS_PLUGIN_ID,
  version: "1.0.0",
  apiVersion: 1,
  displayName: "Chaos test plugin",
  profiles: [
    {
      id: CHAOS_PROFILE_ID,
      version: CHAOS_PROFILE_VERSION,
      manufacturer: "Soulcloud",
      model: "Chaos fixture",
      capabilities: ["test"],
      entities: [
        {
          key: "chaos.counter",
          valueType: "number",
          access: "read",
          category: "counter",
          history: "all",
        },
        {
          key: "chaos.last_kind",
          valueType: "string",
          access: "read",
          category: "diagnostic",
          history: "changes",
        },
        {
          key: "chaos.value",
          valueType: "number",
          access: "read",
          category: "measurement",
          unit: "V",
          history: "sampled",
          sampleIntervalSeconds: 1,
        },
        {
          key: "chaos.mode",
          valueType: "enum",
          access: "read",
          category: "diagnostic",
          enumValues: ["standby", "running", "fault"],
          history: "changes",
        },
      ],
    },
  ],
  actions: [],
  events: [
    { kind: "ok", schemaVersion: 1 },
    { kind: "updates", schemaVersion: 1 },
    { kind: "fail", schemaVersion: 1 },
    { kind: "crash", schemaVersion: 1 },
    { kind: "hang", schemaVersion: 1 },
    { kind: "oom", schemaVersion: 1 },
    { kind: "huge", schemaVersion: 1 },
    { kind: "bulky", schemaVersion: 1 },
    { kind: "slow", schemaVersion: 1 },
  ],
  workflows: [],
  ui: {},
});
