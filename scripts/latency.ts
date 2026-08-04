/**
 * Measures command delivery latency: POST /v1/command-batches -> device
 * receives the MQTT message. Run with both processes started.
 *
 * Run with: bun scripts/latency.ts
 */

import { randomUUID } from "node:crypto";
import mqtt from "mqtt";
import { decodeDeviceCommandExecution, encodeDeviceCommandResult, hashDevicePassword, prisma } from "@soulcloud/core";

const API = "http://localhost:8080";
const MQTT_URL = "mqtt://127.0.0.1:1883";
const DEVICE_UID = `lat-${randomUUID().slice(0, 8)}`;
const PASSWORD = "lat-secret";

const project = await prisma.project.create({
  data: { id: randomUUID(), name: "latency-project" },
});
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
  const client = mqtt.connect(MQTT_URL, {
    clientId: DEVICE_UID,
    username: DEVICE_UID,
    password: PASSWORD,
  });
  await new Promise<void>((resolve, reject) => {
    client.once("connect", () => resolve());
    client.once("error", reject);
    setTimeout(() => reject(new Error("connect timeout")), 5000);
  });
  await new Promise<void>((resolve, reject) => {
    client.subscribe(`soulcloud/v1/devices/${DEVICE_UID}/cmd/exec`, { qos: 1 }, (e) =>
      e ? reject(e) : resolve(),
    );
    setTimeout(() => reject(new Error("subscribe timeout")), 5000);
  });

  // warm-up round (NOTIFY listener must be registered already)
  for (let i = 0; i < 5; i++) {
    const t0 = performance.now();
    const res = await fetch(`${API}/v1/command-batches`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ device_ids: [device.id], command: { cmd: "ping" } }),
    });
    if (res.status !== 202) throw new Error(`enqueue failed: ${res.status}`);
    const latency = await new Promise<number>((resolve) => {
      client.once("message", (topic, payload) => {
        // reply with a terminal result so the per-device queue unblocks
        const exec = decodeDeviceCommandExecution(payload);
        client.publish(
          `soulcloud/v1/devices/${DEVICE_UID}/cmd/result`,
          Buffer.from(encodeDeviceCommandResult({ id: exec.id, seq: exec.seq, code: 0 })),
          { qos: 1 },
          () => {},
        );
        resolve(performance.now() - t0);
      });
      setTimeout(() => resolve(-1), 5000);
    });
    console.log(`round ${i + 1}: enqueue->device = ${latency.toFixed(1)}ms`);
  }

  client.end(true);
} finally {
  await prisma.$executeRaw`DELETE FROM command_batches`;
  await prisma.device.deleteMany({ where: { id: device.id } });
  await prisma.project.delete({ where: { id: project.id } });
  await prisma.$disconnect();
}
