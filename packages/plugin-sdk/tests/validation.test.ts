import { describe, expect, test } from "bun:test";
import { validateEntityUpdates } from "../src/validation";

describe("validateEntityUpdates", () => {
  test("rejects duplicate updates before they reach the database batch", () => {
    expect(() => validateEntityUpdates(
      [{ key: "temperature", valueType: "number", category: "measurement" }],
      [
        { entityKey: "temperature", value: 20 },
        { entityKey: "temperature", value: 21 },
      ],
    )).toThrow("duplicate entity update temperature");
  });
});
