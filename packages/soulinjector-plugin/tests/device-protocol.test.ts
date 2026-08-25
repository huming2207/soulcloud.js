import { describe, expect, test } from "bun:test";
import { debugLogSchema, debugStatusSchema, SOULINJECTOR_COMMAND } from "../src/device-protocol";

describe("SoulInjector device protocol", () => {
  test("keeps command names stable and high-level", () => {
    expect(SOULINJECTOR_COMMAND.flashWrite).toBe("soulinjector.debug.flash_write");
    expect(SOULINJECTOR_COMMAND.start).not.toContain("swd");
  });

  test("bounds status and log event payloads", () => {
    expect(debugStatusSchema.parse({ state: "running", progress: 25, connectionState: "online" })).toMatchObject({ state: "running", progress: 25 });
    expect(debugLogSchema.parse({ level: "info", message: "probe attached" }).message).toBe("probe attached");
    expect(debugStatusSchema.safeParse({ state: "running", progress: 101 }).success).toBe(false);
    expect(debugLogSchema.safeParse({ level: "info", message: "" }).success).toBe(false);
  });
});
