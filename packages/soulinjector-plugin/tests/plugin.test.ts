import { describe, expect, test } from "bun:test";
import { createSoulInjectorPlugin } from "../src/plugin";
import { definePlugin } from "@soulcloud/plugin-sdk";

const saved = {
  id: "00000000-0000-4000-8000-000000000001",
  installationId: "00000000-0000-4000-8000-000000000002",
  projectId: "00000000-0000-4000-8000-000000000003",
  revision: 1,
  yaml: "version: 1\ntargets:\n  - id: fixture\n    displayName: Fixture\n    architecture: cortex-m\n    chip: fixture\n    transport: swd\n    requiredPrimitives: [identify]",
  config: { version: 1 as const, targets: [{ id: "fixture", displayName: "Fixture", architecture: "cortex-m", chip: "fixture", transport: "swd" as const, requiredPrimitives: ["identify" as const] }] },
  sha256: "a".repeat(64),
  createdBy: "00000000-0000-4000-8000-000000000004",
  createdAt: new Date(0).toISOString(),
};

function store() {
  return {
    saveTargetConfig: async () => saved,
    getLatestTargetConfig: async () => saved,
  };
}

describe("SoulInjector plugin", () => {
  test("declares debugger actions with human approval on destructive operations", () => {
    const plugin = createSoulInjectorPlugin(store());
    const validated = definePlugin(plugin);
    expect(validated.manifest.actions.find((action) => action.id === "debug.flash_write")?.requiresHumanApproval).toBe(true);
    expect(validated.manifest.actions.find((action) => action.id === "debug.read_memory")?.requiresHumanApproval).not.toBe(true);
  });

  test("encodes bounded high-level device commands", () => {
    const plugin = createSoulInjectorPlugin(store());
    const args = plugin.encodeAction!["debug.read_memory"]!({ targetConfigRevision: 3, address: 4096, length: 32 });
    expect(args).toEqual([{ targetConfigRevision: 3 }, { address: 4096 }, { length: 32 }]);
  });

  test("stores target config through both RPC and SSR action paths", async () => {
    const calls: string[] = [];
    const repository = {
      saveTargetConfig: async (input: { createdBy: string }) => { calls.push(input.createdBy); return saved; },
      getLatestTargetConfig: async () => saved,
    };
    const plugin = createSoulInjectorPlugin(repository);
    const configured = await plugin.configureTarget!({ operationId: "operation", installationId: saved.installationId, projectId: saved.projectId, userId: saved.createdBy, yaml: saved.yaml }, { signal: AbortSignal.timeout(1000) });
    expect(configured).toMatchObject({ configId: saved.id, revision: 1, targetCount: 1 });
    const result = await plugin.handleAction!["debugger"]!({ yaml: saved.yaml }, { requestId: "request", installationId: saved.installationId, projectId: saved.projectId, user: { id: saved.createdBy, locale: "en", permissions: [] }, routeId: "debugger", params: {} });
    expect(result).toEqual({ redirect: `/plugins/${saved.installationId}/debugger` });
    expect(calls).toEqual([saved.createdBy, saved.createdBy]);
  });
});
