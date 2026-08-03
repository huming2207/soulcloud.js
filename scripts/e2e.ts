/**
 * End-to-end smoke test: HTTP API -> command queue -> MQTT broker -> device.
 *
 * Prerequisites: PostgreSQL running, migrations applied, and the server
 * started with `bun run src/index.ts` (API on :8080, MQTT on :1883).
 *
 * Run with: bun scripts/e2e.ts
 */

import { randomUUID } from "node:crypto";
import mqtt from "mqtt";
import { prisma } from "../src/db";

const API = "http://localhost:8080";
const MQTT_URL = "mqtt://127.0.0.1:1883";
const DEVICE_UID = `e2e-${randomUUID().slice(0, 8)}`;
const PASSWORD = "e2e-secret";

let passed = 0;
let failed = 0;
function check(name: string, condition: boolean, extra = "") {
  if (condition) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    console.log(`  ❌ ${name} ${extra}`);
  }
}

// --- prepare device ---------------------------------------------------------

const project = await prisma.project.create({
  data: { id: randomUUID(), name: "e2e-project" },
});
const device = await prisma.device.create({
  data: {
    id: randomUUID(),
    deviceUid: DEVICE_UID,
    assignedId: "e2e-assigned",
    passwordHash: PASSWORD,
    projectId: project.id,
  },
});
console.log(`device ${DEVICE_UID} created`);

try {
  // --- connect the device ---------------------------------------------------

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
  console.log("device connected to MQTT");

  await new Promise<void>((resolve, reject) => {
    client.subscribe(`soulcloud/v1/devices/${DEVICE_UID}/cmd/exec`, { qos: 1 }, (e) =>
      e ? reject(e) : resolve(),
    );
    setTimeout(() => reject(new Error("subscribe timeout")), 5000);
  });
  console.log("device subscribed to cmd/exec");

  // --- enqueue via HTTP API --------------------------------------------------

  const res = await fetch(`${API}/v1/command-batches`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      device_ids: [device.id],
      command: { cmd: "setLogging", args: [{ enabled: true }] },
    }),
  });
  const batchBody = (await res.json()) as { batch_id: string; device_count: number };
  check("POST /v1/command-batches -> 202", res.status === 202, `got ${res.status}`);
  check("batch has 1 device", batchBody.device_count === 1);

  // --- device receives the command via MQTT ----------------------------------

  const received = new Promise<Buffer>((resolve) => {
    client.once("message", (_t, payload) => resolve(payload));
    setTimeout(() => resolve(Buffer.alloc(0)), 8000);
  });
  const payload = await received;
  check("device received command via MQTT", payload.length > 0);

  // decode and reply
  const { decodeDeviceCommandExecution, encodeDeviceCommandResult } = await import(
    "../src/protocol/command"
  );
  const exec = decodeDeviceCommandExecution(payload);
  check("command decoded (cmd=setLogging)", exec.cmd === "setLogging");

  const resultPacket = Buffer.from(
    encodeDeviceCommandResult({ id: exec.id, seq: exec.seq, code: 0 }),
  );
  await new Promise<void>((resolve, reject) => {
    client.publish(
      `soulcloud/v1/devices/${DEVICE_UID}/cmd/result`,
      resultPacket,
      { qos: 1 },
      (e) => (e ? reject(e) : resolve()),
    );
    setTimeout(() => reject(new Error("result publish timeout")), 5000);
  });

  // --- verify the command completed in the database --------------------------

  await new Promise((r) => setTimeout(r, 500));
  const row = await prisma.deviceCommand.findFirstOrThrow({
    where: { batchId: batchBody.batch_id },
  });
  check("command device_completed in DB", row.state === "device_completed");
  check("result code stored", row.resultCode === 0);
  check("result packet stored verbatim", Buffer.from(row.resultPacket!).equals(resultPacket));

  client.end(true);
} finally {
  await prisma.$executeRaw`DELETE FROM command_batches`;
  await prisma.device.deleteMany({ where: { id: device.id } });
  await prisma.project.delete({ where: { id: project.id } });
  await prisma.$disconnect();
}

console.log(`\nE2E RESULT: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
