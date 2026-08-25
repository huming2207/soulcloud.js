export {
  DEBUGGER_PRIMITIVES,
  targetConfigSchema,
  parseTargetConfigYaml,
  targetConfigHash,
  canonicalTargetConfig,
  type DebuggerPrimitive,
  type DebuggerTarget,
  type TargetConfig,
} from "./target-config";
export {
  SoulInjectorRepository,
  type AppendDebugObservationInput,
  type AppendDebugReportRevisionInput,
  type CreateDebugCaseInput,
  type CreateDebugReportInput,
  type CreateDebugSessionInput,
  type DebugArtifactRecord,
  type DebugCaseRecord,
  type DebugCaseState,
  type DebugObservationRecord,
  type DebugReportRecord,
  type DebugReportRevisionRecord,
  type DebugReportState,
  type DebugSessionRecord,
  type DebugSessionState,
  type SaveArtifactInput,
  type SaveTargetConfigInput,
  type StoreArtifactChunkInput,
  type StoreArtifactChunkOutput,
  type TargetConfigRecord,
} from "./repository";
export { ArtifactValidationError, MAX_ARTIFACT_BYTES, validateArtifact, type DebugArtifactKind, type ValidatedArtifact } from "./artifact";
export { createSoulInjectorPlugin, SOULINJECTOR_PLUGIN_ID, SOULINJECTOR_PLUGIN_VERSION } from "./plugin";
export { SOULINJECTOR_COMMAND, debugLogSchema, debugStatusSchema, type DebugLog, type DebugStatus } from "./device-protocol";
