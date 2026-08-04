/**
 * End-to-end smoke test: HTTP API -> command queue -> MQTT broker -> device.
 *
 * Prerequisites: PostgreSQL running, migrations applied, and BOTH processes
 * started (API on :8080, MQTT broker on :1883):
 *   bun run start:api
 *   bun run start:broker
 *
 * Run with: bun scripts/e2e.ts
 */

import { randomUUID } from "node:crypto";
import { MqttTestClient } from "../packages/broker/tests/helpers/mqtt-client";
import { hashDevicePassword, prisma } from "@soulcloud/core";

const API = "http://localhost:8080";
const MQTT_URL = "ws://127.0.0.1:1883/mqtt";
const E2E_USER = `e2e-${randomUUID().slice(0, 8)}`;
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
    passwordHash: await hashDevicePassword(PASSWORD),
    projectId: project.id,
  },
});
console.log(`device ${DEVICE_UID} created`);

// --- register a user for the protected API ----------------------------------

const reg = await fetch(`${API}/v1/auth/register`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    username: E2E_USER,
    password: "e2e-password-123",
    email: `${E2E_USER}@example.com`,
  }),
});
const regBody = (await reg.json()) as { access_token: string; user_id: string };
check("register -> 201", reg.status === 201, `got ${reg.status}`);
// bind the user to the e2e project (registration created their own)
await prisma.userProject.create({ data: { userId: regBody.user_id, projectId: project.id } });
const authHeaders = { "content-type": "application/json", authorization: `Bearer ${regBody.access_token}` };

try {
  // --- connect the device ---------------------------------------------------

  const client = new MqttTestClient(MQTT_URL, {
    clientId: DEVICE_UID,
    username: DEVICE_UID,
    password: PASSWORD,
  });
  client.on("error", (e) => console.log("mqtt error:", e.message));
  await client.connect();
  console.log("device connected to MQTT");

  await client.subscribe(`soulcloud/v1/devices/${DEVICE_UID}/cmd/exec`);
  console.log("device subscribed to cmd/exec");

  // --- enqueue via HTTP API --------------------------------------------------

  const res = await fetch(`${API}/v1/command-batches`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({
      device_ids: [device.id],
      command: { cmd: "setLogging", args: [{ enabled: true }] },
    }),
  });
  const batchBody = (await res.json()) as { batch_id: string; device_count: number };
  check("POST /v1/command-batches -> 202", res.status === 202, `got ${res.status}`);
  check("batch has 1 device", batchBody.device_count === 1);

  // --- device receives the command via MQTT ----------------------------------

  const payload = await client.waitMessage(`soulcloud/v1/devices/${DEVICE_UID}/cmd/exec`);
  check("device received command via MQTT", payload.length > 0);

  const { decodeDeviceCommandExecution, encodeDeviceCommandResult } = await import(
    "@soulcloud/core"
  );
  const exec = decodeDeviceCommandExecution(payload);
  check("command decoded (cmd=setLogging)", exec.cmd === "setLogging");

  const resultPacket = Buffer.from(
    encodeDeviceCommandResult({ id: exec.id, seq: exec.seq, code: 0 }),
  );
  await client.publish(
    `soulcloud/v1/devices/${DEVICE_UID}/cmd/result`,
    resultPacket,
    1,
  );

  // --- verify the command completed in the database --------------------------

  await new Promise((r) => setTimeout(r, 500));
  const row = await prisma.deviceCommand.findFirstOrThrow({
    where: { batchId: batchBody.batch_id },
  });
  check("command device_completed in DB", row.state === "device_completed");
  check("result code stored", row.resultCode === 0);
  check("result packet stored verbatim", Buffer.from(row.resultPacket!).equals(resultPacket));

  client.end();
} finally {
  await prisma.$executeRaw`DELETE FROM command_batches`;
  await prisma.device.deleteMany({ where: { id: device.id } });
  await prisma.project.delete({ where: { id: project.id } });
  await prisma.$disconnect();
}

console.log(`\nE2E RESULT: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
