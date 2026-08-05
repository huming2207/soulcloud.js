/**
 * End-to-end rollout smoke test against the running API process.
 *
 * Prereqs: postgres up; API started with a short poll interval:
 *   ROLLOUT_POLL_INTERVAL_MS=1000 bun run packages/api/src/index.ts
 * (and the broker, so OTA jobs can be delivered — not needed for this
 * smoke test's DB-level simulation).
 *
 * Flow: register user -> create release + devices -> create a 2-phase
 * rollout -> simulate the phase-1 device completing the upgrade (DB-level:
 * deliver + ack + stat.fw confirmation) -> wait for the advance loop ->
 * verify phase 2 became active -> verify detail endpoint.
 *
 * Usage: bun scripts/e2e-rollout.ts
 */

import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { confirmOtaTargetByFirmware, prisma, recordOtaResult } from "@soulcloud/core";

const API = process.env.API_URL ?? "http://127.0.0.1:8080";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`E2E assertion failed: ${msg}`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor<T>(pred: () => Promise<T | null>, what: string, timeoutMs = 20_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await pred();
    if (v !== null && v !== undefined) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await sleep(200);
  }
}

console.log("== ROLLOUT E2E ==");
const username = `e2e-roll-${randomUUID().slice(0, 8)}`;
const reg = await fetch(`${API}/v1/auth/register`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ username, password: "test-password-123", email: `${username}@example.com` }),
});
assert(reg.status === 201, `register: ${reg.status}`);
const { access_token, user_id } = (await reg.json()) as { access_token: string; user_id: string };
const project = await prisma.project.findFirst({ where: { userLinks: { some: { userId: user_id } } } });
assert(project, "personal project");
const auth = { authorization: `Bearer ${access_token}`, "content-type": "application/json" };

// release (with an ELF so stat.fw confirmation works) + baseline
const { buildNoloadElf } = await import("../packages/core/tests/helpers/elf-builder");
const elf = buildNoloadElf(["value=%d"], ["demo"], 32, true);
const bin = new Uint8Array(64).fill(0x11);
const upload = async (version: string) => {
  const form = new FormData();
  form.append("project_id", project.id);
  form.append("bin", new Blob([bin]), "f.bin");
  form.append("elf", new Blob([elf]), "f.elf");
  form.append("version", version);
  const res = await fetch(`${API}/v1/firmware-releases`, {
    method: "POST",
    headers: { authorization: `Bearer ${access_token}` },
    body: form,
  });
  assert(res.status === 201, `upload ${version}: ${res.status}`);
  return (await res.json()) as { release_id: string };
};
const target = await upload("v2.0.0");
bin.fill(0x22); // different image for the baseline release
const from = await upload("v1.0.0");

// devices
const deviceIds: string[] = [];
const deviceUids: string[] = [];
for (let i = 0; i < 4; i++) {
  const uid = `e2e-roll-dev-${randomUUID().slice(0, 8)}`;
  const d = await prisma.device.create({
    data: { id: randomUUID(), deviceUid: uid, assignedId: `assigned-${i}`, passwordHash: "unused", projectId: project.id },
  });
  deviceIds.push(d.id);
  deviceUids.push(uid);
}

// 2-phase rollout: 50% then 100%
const created = await fetch(`${API}/v1/firmware-releases/${target.release_id}/rollouts`, {
  method: "POST",
  headers: auth,
  body: JSON.stringify({
    strategy: "auto",
    device_ids: deviceIds,
    ratios: [0.5, 1.0],
    from_release_id: from.release_id,
  }),
});
assert(created.status === 201, `create rollout: ${created.status}`);
const { rollout_id, job_id } = (await created.json()) as { rollout_id: string; job_id: string };
console.log(`rollout=${rollout_id} phase1 job=${job_id}`);

// simulate the phase-1 devices completing (2 of 4)
const t1 = await prisma.otaTarget.findMany({
  where: { jobId: job_id },
  include: { device: { select: { deviceUid: true } } },
});
assert(t1.length === 2, `phase1 targets: ${t1.length}`);
for (const t of t1) {
  await prisma.otaTarget.update({ where: { id: t.id }, data: { state: "delivered", deliveredAt: new Date() } });
  await recordOtaResult(prisma, { deviceUid: t.device.deviceUid, jobId: job_id, releaseId: target.release_id, state: "installed", code: 0 });
  await prisma.deviceFirmwareState.upsert({
    where: { deviceId: t.deviceId },
    update: { fwHash: createHash("sha256").update(elf).digest("hex"), reportedAt: new Date() },
    create: { deviceId: t.deviceId, fwHash: createHash("sha256").update(elf).digest("hex") },
  });
  await confirmOtaTargetByFirmware(prisma, t.deviceId, createHash("sha256").update(elf).digest("hex"));
}
console.log("phase-1 devices completed (simulated)");

// wait for the advance loop to activate phase 2
await waitFor(async () => {
  const detail = await fetch(`${API}/v1/ota-rollouts/${rollout_id}`, { headers: auth });
  if (detail.status !== 200) return null;
  const body = (await detail.json()) as { phases: Array<{ state: string; job_id: string | null }> };
  return body.phases[1]?.state === "active" ? body : null;
}, "phase 2 activation");

const detail = await (await fetch(`${API}/v1/ota-rollouts/${rollout_id}`, { headers: auth })).json() as {
  state: string;
  phases: Array<{ index: number; state: string; job_id: string | null; summary: Record<string, number> | null }>;
};
assert(detail.state === "running", `rollout state: ${detail.state}`);
assert(detail.phases[0]!.state === "completed", "phase 1 completed");
assert(detail.phases[1]!.state === "active", "phase 2 active");
assert(detail.phases[1]!.job_id !== null, "phase 2 has a job");
console.log(`advance loop verified: phase1=completed phase2=active (job ${detail.phases[1]!.job_id})`);

// cleanup
await prisma.otaTarget.deleteMany({ where: { job: { projectId: project.id } } });
await prisma.otaJob.deleteMany({ where: { projectId: project.id } });
await prisma.otaRolloutPool.deleteMany({ where: { rollout: { projectId: project.id } } });
await prisma.otaRolloutPhase.deleteMany({ where: { rollout: { projectId: project.id } } });
await prisma.otaRollout.deleteMany({ where: { projectId: project.id } });
await prisma.device.deleteMany({ where: { projectId: project.id } });
await prisma.firmwareRelease.deleteMany({ where: { projectId: project.id } });
await prisma.firmwareArtifact.deleteMany({ where: { projectId: project.id } });
await prisma.project.delete({ where: { id: project.id } });
await prisma.$disconnect();
console.log("== ROLLOUT E2E PASS ==");
