import { describe, expect, test } from "bun:test";
import { pluginTargetConfigRequestBody } from "../src/api/plugin-manager";

const yaml = "version: 1\ntargets:\n  - id: fixture\n    displayName: Fixture\n    architecture: cortex-m\n    chip: fixture\n    transport: swd\n    requiredPrimitives: [identify]\n";

describe("plugin target configuration request", () => {
  test("accepts the JSON wrapper used by API clients", () => {
    expect(pluginTargetConfigRequestBody.parse({ yaml })).toEqual({ yaml });
  });

  test("accepts raw YAML for file/text uploads", () => {
    expect(pluginTargetConfigRequestBody.parse(yaml)).toBe(yaml);
  });

  test("keeps the input bounded", () => {
    expect(() => pluginTargetConfigRequestBody.parse("x".repeat(65_537))).toThrow();
  });
});
