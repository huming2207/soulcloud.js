import type { PluginWorker } from "@soulcloud/plugin-sdk";

/** Runtime implementation, loaded only by the plugin host. */
export const genericDeviceWorker: PluginWorker = {
  async onEvent() {
    return {};
  },
};
