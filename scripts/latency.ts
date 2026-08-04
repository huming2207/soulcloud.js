/**
 * Measures command delivery latency: POST /v1/command-batches -> device
 * receives the MQTT message over WebSocket. Run with both processes
 * started (api + broker, with a valid .env including JWT_SECRET).
 *
 * Run with: bun scripts/latency.ts
 */

import { randomUUID } from "node:crypto";
import { decodeDeviceCommandExecution, encodeDeviceCommandResult, hashDevicePassword, prisma } from "@soulcloud/core";
import { MqttTestClient } from "../packages/broker/tests/helpers/mqtt-client";

const API = process.env.API_URL ?? "http://localhost:8080";
const WS = process.env.MQTT_WS_URL ?? "ws://127.0.0.1:1883/mqtt";
const DEVICE_UID = `lat-${randomUUID().slice(0, 8)}`;
const PASSWORD = "lat-secret";

// register a human (the API requires authentication)
const username = `lat-user-${randomUUID().slice(0, 8)}`;
const reg = await fetch(`${API}/v1/auth/register`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    username,
    password: "test-password-123",
    email: `${username}@example.com`,
  }),
});
if (reg.status !== 201) throw new Error(`register failed: ${reg.status}`);
const { access_token: token, user_id: userId } = (await reg.json()) as {
  access_token: string;
  user_id: string;
};
const project = await prisma.project.findFirst({
  where: { userLinks: { some: { userId } } },
});
if (!project) throw new Error("personal project not found");
const device = await prisma.device.create({
  data: {
    id: randomUUID(),
    deviceUid: DEVICE_UID,
    assignedId: "lat-assigned",
    passwordHash: await hashDevicePassword(PASSWORD),
    projectId: project.id,
  },
});

try {
  const client = new MqttTestClient(WS, {
    clientId: DEVICE_UID,
    username: DEVICE_UID,
    password: PASSWORD,
  });
  await client.connect();
  await client.subscribe(`soulcloud/v1/devices/${DEVICE_UID}/cmd/exec`);

  // warm-up round (NOTIFY listener must be registered already)
  for (let i = 0; i < 5; i++) {
    const t0 = performance.now();
    const res = await fetch(`${API}/v1/command-batches`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ device_ids: [device.id], command: { cmd: "ping" } }),
    });
    if (res.status !== 202) throw new Error(`enqueue failed: ${res.status}`);
    const latency = await new Promise<number>((resolve) => {
      client.once("message", (topic: string, payload: Uint8Array) => {
        // reply with a terminal result so the per-device queue unblocks
        const exec = decodeDeviceCommandExecution(payload);
        client.publish(
          `soulcloud/v1/devices/${DEVICE_UID}/cmd/result`,
          encodeDeviceCommandResult({ id: exec.id, seq: exec.seq, code: 0 }),
        );
        resolve(performance.now() - t0);
      });
      setTimeout(() => resolve(-1), 5000);
    });
    console.log(`round ${i + 1}: enqueue->device = ${latency.toFixed(1)}ms`);
  }

  client.end();
} finally {
  await prisma.deviceCommand.deleteMany({
    where: { device: { projectId: project.id } },
  });
  await prisma.commandBatch.deleteMany({
    where: { commands: { none: {} }, createdAt: { lt: new Date() } },
  });
  await prisma.device.deleteMany({ where: { id: device.id } });
  await prisma.project.deleteMany({ where: { id: project.id } });
  await prisma.$disconnect();
}
