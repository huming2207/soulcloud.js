/**
 * End-to-end OTA flow against the running API + broker processes.
 *
 * Prereqs: docker compose up -d postgres; bun run packages/api/src/index.ts;
 * bun run packages/broker/src/index.ts (both with .env / DATABASE_URL set).
 *
 * Flow: register user → upload release (bin+elf) → deploy to a device →
 * MQTT ota notice received (msgpack: metadata + per-device JWT) →
 * HTTP download with the JWT → bytes match → re-download refused (expired
 * semantics covered by unit tests; here we verify the happy path).
 *
 * Usage: bun scripts/e2e-ota.ts
 */

import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { decode, encode } from "../packages/core/node_modules/@msgpack/msgpack";
import { MqttTestClient } from "../packages/broker/tests/helpers/mqtt-client";
import { hashDevicePassword, prisma } from "@soulcloud/core";

const API = process.env.API_URL ?? "http://127.0.0.1:8080";
const WS = process.env.MQTT_WS_URL ?? "ws://127.0.0.1:1883/mqtt";

const bin = new Uint8Array(4096);
for (let i = 0; i < bin.length; i++) bin[i] = (i * 13 + 7) & 0xff;
const binHash = createHash("sha256").update(bin).digest("hex");

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`E2E assertion failed: ${msg}`);
}

const username = `e2e-ota-${randomUUID().slice(0, 8)}`;
const deviceUid = `e2e-ota-dev-${randomUUID().slice(0, 8)}`;
const devicePassword = "e2e-device-password";

console.log("== OTA E2E ==");

// 1. register a human + create the device
const reg = await fetch(`${API}/v1/auth/register`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    username,
    password: "test-password-123",
    email: `${username}@example.com`,
  }),
});
assert(reg.status === 201, `register: ${reg.status}`);
const { access_token, user_id } = (await reg.json()) as {
  access_token: string;
  user_id: string;
};
const project = await prisma.project.findFirst({
  where: { userLinks: { some: { userId: user_id } } },
});
assert(project, "personal project");
const device = await prisma.device.create({
  data: {
    id: randomUUID(),
    deviceUid,
    assignedId: "assigned-e2e-ota",
    passwordHash: await hashDevicePassword(devicePassword),
    projectId: project.id,
  },
});
console.log(`user=${username} device=${deviceUid}`);

const auth = { authorization: `Bearer ${access_token}` };

// 2. upload a release (bin only)
const form = new FormData();
form.append("project_id", project.id);
form.append("bin", new Blob([bin]), "firmware.bin");
const up = await fetch(`${API}/v1/firmware-releases`, {
  method: "POST",
  headers: auth,
  body: form,
});
assert(up.status === 201, `upload release: ${up.status}`);
const { release_id } = (await up.json()) as { release_id: string };
console.log(`release=${release_id} bin_sha256=${binHash.slice(0, 12)}…`);

// 3. device connects over MQTT/WS and subscribes to its ota topic
const client = new MqttTestClient(WS, {
  clientId: deviceUid,
  username: deviceUid,
  password: devicePassword,
});
const notices: Array<Uint8Array> = [];
client.on("message", (topic: string, payload: Uint8Array) => {
  if (topic.endsWith("/ota")) notices.push(payload);
});
await client.connect();
await client.subscribe(`soulcloud/v1/devices/${deviceUid}/ota`);
console.log("device connected");

// 4. deploy
const dep = await fetch(`${API}/v1/firmware-releases/${release_id}/deploy`, {
  method: "POST",
  headers: { ...auth, "content-type": "application/json" },
  body: JSON.stringify({ device_ids: [device.id] }),
});
assert(dep.status === 201, `deploy: ${dep.status}`);
const { job_id } = (await dep.json()) as { job_id: string };
console.log(`deployed job=${job_id}`);

// 5. wait for the ota notice (LISTEN/NOTIFY wake-up makes this fast)
const deadline = Date.now() + 10_000;
while (notices.length === 0 && Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 50));
}
assert(notices.length === 1, "ota notice received");
const notice = decode(notices[0]!) as Record<string, unknown>;
const download = notice.download as Record<string, unknown>;
assert(notice.release_id === release_id, "notice release id");
assert(notice.bin_sha256 === binHash, "notice bin hash");
assert((notice.bin_size as number) === bin.byteLength, "notice bin size");
console.log("ota notice received over MQTT");

// 6. the device downloads the bin over HTTP with its JWT
const dl = await fetch(`${API}${download.url}?token=${download.token}`);
assert(dl.status === 200, `download: ${dl.status}`);
const got = new Uint8Array(await dl.arrayBuffer());
assert(got.byteLength === bin.byteLength, "download size");
assert(
  createHash("sha256").update(got).digest("hex") === binHash,
  "download bytes match",
);
console.log(`downloaded ${got.byteLength} bytes, sha256 verified`);

// 7. a human can download directly with Bearer
const human = await fetch(`${API}/v1/firmware-releases/${release_id}/bin`, {
  headers: auth,
});
assert(human.status === 200, `human download: ${human.status}`);
console.log("human Bearer download ok");

// 8. the device acks downloaded + installed over MQTT
for (const state of ["downloaded", "installed"] as const) {
  client.publish(
    `soulcloud/v1/devices/${deviceUid}/ota/result`,
    encode({ release_id, job_id, state, code: 0 }),
  );
  await new Promise((r) => setTimeout(r, 150));
}
console.log("device acks sent (downloaded + installed)");

// 9. job query shows the intermediate state (awaiting run confirmation)
const jobRes = await fetch(`${API}/v1/ota-jobs/${job_id}`, { headers: auth });
assert(jobRes.status === 200, `job query: ${jobRes.status}`);
const jobBody = (await jobRes.json()) as {
  targets: Array<{ state: string }>;
  summary: Record<string, number>;
};
assert(jobBody.targets[0]!.state === "installed", `target state: ${jobBody.targets[0]!.state}`);
assert(jobBody.summary.installed === 1, `summary: ${JSON.stringify(jobBody.summary)}`);
console.log(`job query: target=${jobBody.targets[0]!.state} summary=${JSON.stringify(jobBody.summary)}`);

// cleanup
client.end();
await prisma.otaTarget.deleteMany({ where: { job: { projectId: project.id } } });
await prisma.otaJob.deleteMany({ where: { projectId: project.id } });
await prisma.firmwareRelease.deleteMany({ where: { projectId: project.id } });
await prisma.device.delete({ where: { id: device.id } });
await prisma.project.delete({ where: { id: project.id } });
await prisma.$disconnect();
console.log("== OTA E2E PASS ==");
