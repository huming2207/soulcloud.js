import { z } from "zod";

/**
 * Environment variable schemas shared by the API and broker processes.
 * Each process composes its own schema from these fragments.
 */
export const SharedEnv = {
  DATABASE_URL: z.string().url(),
  LOG_LEVEL: z
    .enum(["trace", "debug", "info", "warn", "error"])
    .default("info"),
};

export type Config = z.infer<typeof SharedEnv>;

/**
 * Parses and validates the environment against a schema. Exits the process
 * with a readable listing on failure.
 */
export function loadEnv<T extends z.ZodType>(schema: T): z.infer<T> {
  const result = schema.safeParse(process.env);
  if (!result.success) {
    console.error("Invalid environment configuration:");
    for (const issue of result.error.issues) {
      console.error(`  - ${issue.path.join(".")}: ${issue.message}`);
    }
    process.exit(1);
  }
  return result.data;
}
