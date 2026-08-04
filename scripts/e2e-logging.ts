/**
 * End-to-end smoke test for log ingestion:
 *   1. upload the demo ELF via the API
 *   2. device connects via MQTT, reports stat (fw), publishes on9log packets
 *   3. query the logs API and verify decoded messages
 *
 * Requires both processes running (bun run start:api / start:broker).
 * Run with: bun scripts/e2e-logging.ts
 */

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { MqttTestClient } from "../packages/broker/tests/helpers/mqtt-client";
import { encodeDeviceStat, prisma } from "@soulcloud/core";
import { SlipDecoder } from "../packages/core/tests/helpers/slip";
import { ON9LOG_FRAME_TYPE_ON9LOG } from "../packages/core/tests/helpers/slip";

const API = "http://localhost:8080";
const MQTT_URL = "ws://127.0.0.1:1883/mqtt";
const DEMO_ELF = "/tmp/on9log_unix_demo";
const DEMO_OUTPUT = "/tmp/on9log_demo_output.bin";
const DEVICE_UID = `e2e-log-${randomUUID().slice(0, 8)}`;
const PASSWORD = "e2e-secret";

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, extra = "") {
  if (ok) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    console.log(`  ❌ ${name} ${extra}`);
  }
}

const elf = readFileSync(DEMO_ELF);
const packets = (() => {
  const d = new SlipDecoder();
  d.push(readFileSync(DEMO_OUTPUT));
  return d
    .frames()
    .filter((f) => f.type === ON9LOG_FRAME_TYPE_ON9LOG)
    .map((f) => f.payload);
})();
const fwHash = (() => {
  const { createHash } = require("node:crypto") as typeof import("node:crypto");
  return createHash("sha256").update(elf).digest("hex");
})();

const project = await prisma.project.create({
  data: { id: randomUUID(), name: "e2e-log-project" },
});
const device = await prisma.device.create({
  data: {
    id: randomUUID(),
    deviceUid: DEVICE_UID,
    assignedId: "e2e-log",
    passwordHash: PASSWORD,
    projectId: project.id,
  },
});

try {
  // --- 1. upload the ELF ------------------------------------------------------

  const form = new FormData();
  form.append("project_id", project.id);
  form.append("file", new Blob([elf]), "firmware.elf");
  const up = await fetch(`${API}/v1/firmware-artifacts`, {
    method: "POST",
    body: form,
  });
  const upBody = (await up.json()) as {
    artifact_id: string;
    build_id: string;
    tag_count: number;
    format_count: number;
  };
  check("ELF upload -> 201", up.status === 201, `got ${up.status}`);
  check("build_id is the ELF SHA-256", upBody.build_id === fwHash);
  check("dictionary extracted", upBody.tag_count > 0 && upBody.format_count > 0);

  // --- 2. device: connect, report fw, publish logs ----------------------------

  const client = new MqttTestClient(MQTT_URL, {
    clientId: DEVICE_UID,
    username: DEVICE_UID,
    password: PASSWORD,
  });
  client.on("error", (e) => console.log("mqtt error:", e.message));
  await client.connect();

  // report firmware (stat.fw = firmware hash bytes)
  await client.publish(
    `soulcloud/v1/devices/${DEVICE_UID}/stat`,
    Buffer.from(
      encodeDeviceStat({
        sn: new Uint8Array(4),
        fw: Buffer.from(fwHash, "hex"),
        up: 1n,
        rst: "power-on",
      }),
    ),
    1,
  );
  await new Promise((r) => setTimeout(r, 300));

  // publish a few real on9log packets
  for (const packet of packets.slice(0, 5)) {
    await client.publish(`soulcloud/v1/devices/${DEVICE_UID}/log`, Buffer.from(packet), 1);
  }
  await new Promise((r) => setTimeout(r, 500));
  client.end();

  // --- 3. query the logs API ---------------------------------------------------

  const logs = await fetch(`${API}/v1/devices/${device.id}/logs?limit=10`);
  const logsBody = (await logs.json()) as {
    events: Array<{
      id: string;
      message: string | null;
      tag: string | null;
      decode_state: string;
    }>;
  };
  check("logs query -> 200", logs.status === 200);
  check("stored 5 events", logsBody.events.length === 5, `got ${logsBody.events.length}`);
  const decoded = logsBody.events.filter((e) => e.message !== null);
  check("events decodable", decoded.length === 5, `got ${decoded.length}`);
  check("tag resolved", decoded.every((e) => e.tag === "demo"));
  check("messages rendered", decoded.every((e) => e.message!.length > 0));
  console.log("  sample:", JSON.stringify(decoded[0]?.message));
} finally {
  await prisma.rawLogEvent.deleteMany({ where: { deviceId: device.id } });
  await prisma.deviceFirmwareState.deleteMany({ where: { deviceId: device.id } });
  await prisma.firmwareLogString.deleteMany({ where: { artifact: { projectId: project.id } } });
  await prisma.firmwareArtifact.deleteMany({ where: { projectId: project.id } });
  await prisma.device.deleteMany({ where: { id: device.id } });
  await prisma.project.delete({ where: { id: project.id } });
  await prisma.$disconnect();
}

console.log(`\nE2E LOGGING RESULT: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
