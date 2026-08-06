/**
 * config.ts tests: loadEnv parses valid environments and exits with a
 * readable listing on invalid ones.
 */
import { describe, expect, mock, spyOn, test } from "bun:test";
import { loadEnv, SharedEnv } from "../src/config";
import { z } from "zod";

const testSchema = z.object({
  ...SharedEnv,
  SOME_PORT: z.coerce.number().int().positive().default(1234),
});

describe("loadEnv", () => {
  test("parses a valid environment", () => {
    const parsed = loadEnv(testSchema);
    expect(parsed.DATABASE_URL).toBe(process.env.DATABASE_URL!);
    expect(parsed.LOG_LEVEL).toBe("info");
    expect(parsed.SOME_PORT).toBe(1234);
  });

  test("exits with a readable listing on invalid configuration", () => {
    const exit = spyOn(process, "exit").mockImplementation((() => {}) as never);
    const error = spyOn(console, "error").mockImplementation(() => {});
    const prev = process.env.DATABASE_URL;
    try {
      // deleting the required env var makes the config invalid
      delete process.env.DATABASE_URL;
      loadEnv(testSchema);
      expect(exit).toHaveBeenCalledWith(1);
      const messages = error.mock.calls.map((c) => String(c[0])).join("\n");
      expect(messages).toContain("DATABASE_URL");
    } finally {
      if (prev !== undefined) process.env.DATABASE_URL = prev;
      exit.mockRestore();
      error.mockRestore();
    }
  });
});
