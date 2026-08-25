import { describe, expect, test } from "bun:test";
import { pluginUiArtifactQuerySchema } from "../src/server";

const filename = "firmware.elf";

describe("plugin UI artifact upload metadata", () => {
  test("accepts bounded ELF metadata", () => {
    expect(pluginUiArtifactQuerySchema.parse({ kind: "elf", filename })).toEqual({
      kind: "elf",
      filename,
      content_type: "application/octet-stream",
    });
  });

  test("rejects path traversal and header injection", () => {
    expect(() => pluginUiArtifactQuerySchema.parse({ kind: "elf", filename: "../firmware.elf" })).toThrow();
    expect(() => pluginUiArtifactQuerySchema.parse({ kind: "firmware", filename, content_type: "text/plain\nX-Injected: yes" })).toThrow();
  });
});
