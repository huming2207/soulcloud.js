import { describe, expect, test } from "bun:test";
import {
  canonicalTargetConfig,
  parseTargetConfigYaml,
  targetConfigHash,
} from "../src/target-config";

const validYaml = `
version: 1
targets:
  - id: stm32g0-swd
    displayName: STM32G0 SWD
    architecture: cortex-m0plus
    chip: stm32g0
    transport: swd
    requiredPrimitives:
      - identify
      - halt
      - read-registers
      - read-memory
      - reset
`;

describe("SoulInjector target configuration", () => {
  test("parses configurable architecture, chip and primitive requirements", () => {
    const config = parseTargetConfigYaml(validYaml);
    expect(config.targets[0]).toMatchObject({
      id: "stm32g0-swd",
      architecture: "cortex-m0plus",
      chip: "stm32g0",
      transport: "swd",
      requiredPrimitives: ["identify", "halt", "read-registers", "read-memory", "reset"],
    });
  });

  test("allows repeated mapping keys in separate target list items", () => {
    const config = parseTargetConfigYaml(`${validYaml}
  - id: esp32-uart
    displayName: ESP32 UART
    architecture: xtensa
    chip: esp32
    transport: uart
    requiredPrimitives:
      - identify
      - read-memory
`);
    expect(config.targets.map((target) => target.id)).toEqual(["stm32g0-swd", "esp32-uart"]);
  });

  test("rejects duplicate target ids and primitives", () => {
    expect(() => parseTargetConfigYaml(validYaml.replace("- reset", "- halt\n      - reset"))).toThrow("requiredPrimitives must not contain duplicates");
    expect(() => parseTargetConfigYaml(`${validYaml}\n  - id: stm32g0-swd\n    displayName: duplicate\n    architecture: cortex-m0plus\n    chip: stm32g0\n    transport: swd\n    requiredPrimitives: [identify]`)).toThrow("target id must be unique");
  });

  test("rejects unsafe YAML features and invalid UART primitive combinations", () => {
    expect(() => parseTargetConfigYaml("version: 1\ntargets: &targets []\n" )).toThrow();
    expect(() => parseTargetConfigYaml(validYaml.replace("transport: swd", "transport: uart").replace("- reset", "- stack-trace"))).toThrow("UART targets cannot require");
  });

  test("canonical hash is independent of YAML key order", async () => {
    const first = parseTargetConfigYaml(validYaml);
    const second = parseTargetConfigYaml(validYaml.replace("displayName: STM32G0 SWD\n", "displayName: STM32G0 SWD\n"));
    expect(canonicalTargetConfig(first)).toBe(canonicalTargetConfig(second));
    expect(await targetConfigHash(first)).toBe(await targetConfigHash(second));
  });

  test("rejects an oversized document before parsing", () => {
    expect(() => parseTargetConfigYaml(`${validYaml}\n#${"x".repeat(70_000)}`)).toThrow("exceeds");
  });
});
