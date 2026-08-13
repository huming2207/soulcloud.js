/**
 * Aedes broker throughput benchmark (raw broker, no auth/DB in the path):
 * connection establishment, QoS1 uplink, QoS1 downlink fanout and
 * loopback RTT. Run with: bun scripts/bench-aedes.ts
 *
 * Uses the same WebSocket transport and test client as the broker test
 * suite, so the numbers reflect the real runtime (Bun 1.3 + Aedes 1.1 +
 * mqtt-packet codec) rather than an idealized socket benchmark.
 */

import { performance } from "node:perf_hooks";
import { readFileSync } from "node:fs";
// aedes is a dependency of @soulcloud/broker only; the root scripts dir
// cannot resolve it as a bare specifier, so import via its real path
// (types + runtime stay consistent with the broker build).
import { Aedes, type Client, type PublishPacket } from "../packages/broker/node_modules/aedes/aedes.js";
import { startWsBroker } from "../packages/broker/src/mqtt/ws-adapter";
import { MqttTestClient } from "../packages/broker/tests/helpers/mqtt-client";

const AEDES_VERSION = (JSON.parse(readFileSync("packages/broker/node_modules/aedes/package.json", "utf8")) as { version: string }).version;

const PAYLOAD_64 = new Uint8Array(64);
const PAYLOAD_1K = new Uint8Array(1024);

function fmt(n: number): string {
  return n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : n.toFixed(1);
}

async function waitForConnect(client: MqttTestClient, timeoutMs = 10_000): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    client.once("connect", () => resolve());
    client.once("error", reject);
    setTimeout(() => reject(new Error("connect timeout")), timeoutMs);
  });
}

async function main(): Promise<void> {
  const aedes = await Aedes.createBroker();
  const server = await startWsBroker(aedes, { port: 0, path: "/mqtt" });
  const url = `ws://127.0.0.1:${server.port}/mqtt`;
  console.log(`Aedes ${AEDES_VERSION} on Bun ${Bun.version}, ws://127.0.0.1:${server.port}/mqtt\n`);

  // --- 1. connection establishment ------------------------------------------
  {
    const TOTAL = 1000;
    const WAVE = 50;
    const clients: MqttTestClient[] = [];
    const t0 = performance.now();
    for (let i = 0; i < TOTAL; i += WAVE) {
      const wave = Array.from({ length: WAVE }, (_, j) =>
        new MqttTestClient(url, { clientId: `bench-conn-${i + j}`, keepalive: 60 }),
      );
      wave.forEach((c) => void c.connect().catch(() => {}));
      await Promise.all(wave.map((c) => waitForConnect(c)));
      clients.push(...wave);
    }
    const elapsed = performance.now() - t0;
    console.log(
      `  connections: ${TOTAL} in ${(elapsed / 1000).toFixed(2)}s = ${fmt((TOTAL / elapsed) * 1000)} conn/s (${WAVE} concurrent waves)`,
    );
    const alive = (aedes as unknown as { connectedClients?: number }).connectedClients;
    console.log(`  broker reports ${alive} live clients`);
    for (const c of clients) c.end();
    await Bun.sleep(500);
  }

  // --- 2. QoS1 uplink throughput (device -> broker) --------------------------
  {
    const CLIENTS = 200;
    const PER_CLIENT = 500; // 100k messages total
    const clients: MqttTestClient[] = [];
    for (let i = 0; i < CLIENTS; i++) {
      const c = new MqttTestClient(url, { clientId: `bench-up-${i}`, keepalive: 60 });
      void c.connect().catch(() => {});
      clients.push(c);
    }
    await Promise.all(clients.map((c) => waitForConnect(c)));

    let received = 0;
    aedes.on("publish", (_packet: PublishPacket, client: Client | null) => {
      if (client) received += 1;
    });
    const t0 = performance.now();
    await Promise.all(
      clients.map((c, i) =>
        (async () => {
          for (let n = 0; n < PER_CLIENT; n++) {
            await c.publish(`bench/up/${i}`, PAYLOAD_64);
          }
        })(),
      ),
    );
    // sending resolves at the WS layer; wait until the BROKER actually
    // received every message before stopping the clock
    const deadline = Date.now() + 30_000;
    while (received < CLIENTS * PER_CLIENT && Date.now() < deadline) {
      await Bun.sleep(10);
    }
    const elapsed = performance.now() - t0;
    console.log(
      `  uplink 64B x ${fmt(CLIENTS * PER_CLIENT)}: ${fmt(((received / elapsed) * 1000))} msg/s (${received} received, ${(elapsed / 1000).toFixed(2)}s)`,
    );
    for (const c of clients) c.end();
    await Bun.sleep(300);
  }

  // --- 3. QoS1 downlink fanout (broker -> N subscribers) ----------------------
  {
    const SUBSCRIBERS = 500;
    const MESSAGES = 200; // 100k deliveries
    const clients: MqttTestClient[] = [];
    for (let i = 0; i < SUBSCRIBERS; i++) {
      const c = new MqttTestClient(url, { clientId: `bench-down-${i}`, keepalive: 60 });
      void c.connect().catch(() => {});
      clients.push(c);
    }
    await Promise.all(clients.map((c) => waitForConnect(c)));
    await Promise.all(clients.map((c) => c.subscribe("bench/down")));
    await Bun.sleep(200);

    let delivered = 0;
    const done = new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (delivered >= SUBSCRIBERS * MESSAGES) {
          clearInterval(check);
          resolve();
        }
      }, 50);
    });
    clients.forEach((c) => c.on("message", () => { delivered += 1; }));

    const t0 = performance.now();
    for (let n = 0; n < MESSAGES; n++) {
      aedes.publish({ cmd: "publish", topic: "bench/down", payload: Buffer.from(PAYLOAD_1K), qos: 1, retain: false, dup: false }, () => {});
    }
    await done;
    const elapsed = performance.now() - t0;
    console.log(
      `  downlink 1KB x ${SUBSCRIBERS} subs x ${MESSAGES}: ${fmt((delivered / elapsed) * 1000)} deliveries/s (${fmt(delivered)} total, ${(elapsed / 1000).toFixed(2)}s)`,
    );
    for (const c of clients) c.end();
    await Bun.sleep(300);
  }

  // --- 4. loopback RTT (device -> broker -> same device) ---------------------
  {
    const ROUNDS = 2000;
    const client = new MqttTestClient(url, { clientId: "bench-rtt", keepalive: 60 });
    void client.connect().catch(() => {});
    await waitForConnect(client);
    await client.subscribe("bench/rtt/back");

    // broker echoes every uplink back on the loopback topic
    const echo = (_packet: PublishPacket, cl: Client | null) => {
      if (!cl) return;
      aedes.publish(
        { cmd: "publish", topic: "bench/rtt/back", payload: Buffer.from(PAYLOAD_64), qos: 1, retain: false, dup: false },
        () => {},
      );
    };
    aedes.on("publish", echo);

    const latencies: number[] = [];
    // serial single-flight rounds: one message in flight at a time, so the
    // latency is per-message (the batch variant above would include queue
    // buildup latency)
    for (let n = 0; n < ROUNDS; n++) {
      const started = performance.now();
      const echoed = new Promise<void>((resolve) => client.once("message", () => resolve()));
      await client.publish("bench/rtt", PAYLOAD_64);
      await echoed;
      latencies.push(performance.now() - started);
    }
    latencies.sort((a, b) => a - b);
    const p50 = latencies[Math.floor(latencies.length * 0.5)]!;
    const p99 = latencies[Math.floor(latencies.length * 0.99)]!;
    console.log(
      `  loopback RTT (64B, ${ROUNDS} rounds): p50 ${p50.toFixed(2)}ms, p99 ${p99.toFixed(2)}ms, max ${latencies[latencies.length - 1]!.toFixed(2)}ms`,
    );
    client.end();
  }

  server.server.stop(true);
  aedes.close();
  console.log("\ndone");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
