import { expect, test } from "bun:test";
import { PluginOperationRegistry, PluginOperationLimitError } from "../src/operation";
import type { PluginEventRow } from "@soulcloud/core";

const event: PluginEventRow = {
  id: "event-1",
  pluginInstallationId: "installation-1",
  projectId: "project-1",
  deviceId: "device-1",
  deviceUid: "uid-1",
  pluginId: "plugin-1",
  profileId: "profile-1",
  profileVersion: 1,
  eventKind: "kind",
  schemaVersion: 1,
  payload: {},
  state: "leased",
  attemptCount: 1,
  installationConfig: {},
  createdAt: new Date(),
};

function registry(overrides: Partial<ConstructorParameters<typeof PluginOperationRegistry>[0]> = {}) {
  return new PluginOperationRegistry({
    maxOperations: 1,
    maxReverseInFlight: 1,
    perPluginReverseInFlight: 1,
    perInstallationReverseInFlight: 1,
    perOperationReverseInFlight: 1,
    maxReverseCallsPerOperation: 2,
    maxStagedCommandsPerOperation: 1,
    maxBlobsPerOperation: 1,
    maxBlobBytesPerOperation: 8,
    ...overrides,
  }, async (_event, entityKey) => ({
    entityKey,
    value: 3,
    quality: "good",
    sourceTimestamp: null,
    ingestedAt: new Date().toISOString(),
    alarm: null,
  }));
}

test("operation scopes reverse reads and stages commands until finish", async () => {
  const operations = registry();
  const operation = operations.begin(event, 5_000);
  const wire = { operationId: operation.operationId, operationToken: operation.token };
  const state = await operations.entityGet({ ...wire, entityKey: "counter" }, new AbortController().signal);
  expect(state?.value).toBe(3);
  await operations.commandEnqueue({
    ...wire,
    command: "test",
    args: [{ name: "value", value: 1 }],
  }, new AbortController().signal);
  expect(operations.finish(operation.token)?.stagedCommands).toEqual([
    { command: "test", args: [{ value: 1 }] },
  ]);
});

test("operation limits reject extra staged commands and calls", async () => {
  const operations = registry();
  const operation = operations.begin(event, 5_000);
  const wire = { operationId: operation.operationId, operationToken: operation.token };
  await operations.commandEnqueue({ ...wire, command: "test", args: [] }, new AbortController().signal);
  await expect(operations.commandEnqueue({ ...wire, command: "test", args: [] }, new AbortController().signal)).rejects.toBeInstanceOf(PluginOperationLimitError);
  operations.discard(operation.token);
});

test("operation token is bound to the creating WebSocket connection", async () => {
  const operations = registry();
  const operation = operations.begin(event, 5_000, "connection-a");
  await expect(operations.entityGet({
    operationId: operation.operationId,
    operationToken: operation.token,
    entityKey: "counter",
  }, new AbortController().signal, "connection-b")).rejects.toThrow("not active");
  operations.discard(operation.token);
});
