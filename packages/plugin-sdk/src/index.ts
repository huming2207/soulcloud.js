/**
 * Plugin SDK — the contract between SoulcloudJS core services and plugins.
 *
 * Layers (stage 1 skeleton, docs/zh/plugin-and-station-architecture.md §2):
 *
 *   - `types.ts`      plugin-facing types: manifests, profiles, entity
 *                     descriptors, the worker interface and the scoped
 *                     PluginContext plugins receive at runtime.
 *   - `validation.ts` shared pure validators (entity values, descriptors).
 *                     Used by BOTH the Plugin Host (pre-check plugin output)
 *                     and the Dispatcher (authoritative check) — the host is
 *                     untrusted-side, the dispatcher re-validates everything.
 *   - `rpc.ts`        the Dispatcher <-> Plugin Host HTTP JSON-RPC message
 *                     contract (§6.5).
 *
 * The SDK never imports Prisma, the database or anything from the API/broker:
 * a plugin process holding only this package has no credentials to misuse.
 */

export * from "./types";
export * from "./validation";
export * from "./define";
export * from "./rpc";
