import { expect, test } from "bun:test";
import { encode as encodeOtaResult } from "@msgpack/msgpack";
import { Aedes } from "aedes";
import { encodeDeviceCommandResult, type PrismaClient } from "@soulcloud/core";
import { attachDispatch } from "../../src/mqtt/dispatch";

const log = { info() {}, warn() {}, debug() {} };
const uid = "result-durability";

for (const kind of ["cmd/result", "ota/result"] as const) {
  function setup(persist: () => Promise<unknown>, rateBurst = 100) {
    const prisma = {
      $transaction: persist,
      device: { findUnique: async () => ({ id: "device" }) },
      otaTarget: { findFirst: async () => ({ id: "target", job: { releaseId: "00000000-0000-4000-8000-000000000001" } }), updateMany: persist },
    } as unknown as PrismaClient;
    const aedes = new Aedes();
    attachDispatch(aedes, prisma, log, { maxPacketBytes: 4096, ratePerSecond: 1, rateBurst });
    const payload = kind === "cmd/result"
      ? encodeDeviceCommandResult({ id: new Uint8Array(16), seq: 1n, code: 0, payload: null })
      : encodeOtaResult({ release_id: "00000000-0000-4000-8000-000000000001", job_id: "00000000-0000-4000-8000-000000000002", state: "installed", code: 0 });
    const packet = { topic: `soulcloud/v1/devices/${uid}/${kind}`, payload: Buffer.from(payload), qos: 1, messageId: 1 };
    const client = { id: uid };
    const authorize = () => new Promise<Error | null | undefined>((resolve) => {
      aedes.authorizePublish(client as never, packet as never, resolve);
    });
    return { aedes, packet, client, authorize };
  }

  test(`${kind}: acknowledgement waits for persistence and publish does not repeat it`, async () => {
    let release!: () => void;
    let writes = 0;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const { aedes, packet, client, authorize } = setup(async () => { writes++; await pending; return { count: 1 }; });
    let acknowledged = false;
    const completion = authorize().then((error) => { acknowledged = true; return error; });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(writes).toBe(1);
    expect(acknowledged).toBe(false);
    release();
    expect(await completion).toBeNull();
    aedes.emit("publish", packet as never, client as never);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(writes).toBe(1);
  });

  test(`${kind}: persistence failure rejects acknowledgement`, async () => {
    const { authorize } = setup(async () => { throw new Error("database unavailable"); });
    expect((await authorize())?.message).toBe("database unavailable");
  });

  test(`${kind}: rate limiting rejects rather than silently acknowledges`, async () => {
    const { authorize } = setup(async () => ({ count: 1 }), 1);
    expect(await authorize()).toBeNull();
    expect(await authorize()).toBeInstanceOf(Error);
  });
}
