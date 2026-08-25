import { describe, expect, test } from "bun:test";
import { actionCommandOrigin } from "../src/manager";

describe("plugin action command provenance", () => {
  test("records explicitly approved actions as human-origin", () => {
    expect(actionCommandOrigin(true)).toBe("human");
  });

  test("keeps unapproved internal actions plugin-origin", () => {
    expect(actionCommandOrigin()).toBe("plugin");
    expect(actionCommandOrigin(false)).toBe("plugin");
  });
});
