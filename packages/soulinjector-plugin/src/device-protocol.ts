import { z } from "zod";

export const SOULINJECTOR_COMMAND = {
  identify: "soulinjector.debug.identify",
  halt: "soulinjector.debug.halt",
  resume: "soulinjector.debug.resume",
  reset: "soulinjector.debug.reset",
  readMemory: "soulinjector.debug.read_memory",
  readRegisters: "soulinjector.debug.read_registers",
  start: "soulinjector.debug.start",
} as const;

const debugState = z.enum(["idle", "running", "halted", "failed", "completed", "awaiting_approval"]);
const connectionState = z.enum(["offline", "online", "unknown"]);

export const debugStatusSchema = z.object({
  state: debugState,
  connectionState: connectionState.optional(),
  progress: z.number().finite().min(0).max(100).optional(),
  target: z.string().min(1).max(128).optional(),
  sessionId: z.string().min(1).max(128).optional(),
  error: z.string().max(4096).optional(),
}).strict();

export const debugLogSchema = z.object({
  level: z.enum(["debug", "info", "warn", "error"]),
  message: z.string().min(1).max(4096),
  sessionId: z.string().min(1).max(128).optional(),
}).strict();

export type DebugStatus = z.infer<typeof debugStatusSchema>;
export type DebugLog = z.infer<typeof debugLogSchema>;
