import { describe, expect, test } from "bun:test";
import mqttpacket from "mqtt-packet";
import { createWsDuplex, DEFAULT_MAX_FRAME_BYTES } from "../../src/mqtt/ws-adapter";

const { generate } = mqttpacket as unknown as {
  generate: (packet: Record<string, unknown>) => Buffer;
};

type AdapterSocket = Parameters<typeof createWsDuplex>[0];

function fakeSocket(sendResult: number) {
  const data = {
    duplex: null,
    resumeWrite: null as ((error?: Error) => void) | null,
    partial: null,
    maxPacketBytes: DEFAULT_MAX_FRAME_BYTES,
  };
  let sends = 0;
  const socket = {
    data,
    send() {
      sends++;
      return sendResult;
    },
    close() {},
  } as unknown as AdapterSocket;
  return { socket, data, sends: () => sends };
}

describe("Bun WebSocket Duplex backpressure", () => {
  test("holds the Node write callback until Bun reports drain", async () => {
    const { socket, data, sends } = fakeSocket(-1);
    const duplex = createWsDuplex(socket);
    let settled = false;
    const finished = new Promise<void>((resolve, reject) => {
      duplex.write(generate({ cmd: "pingresp" }), (error) => {
        settled = true;
        if (error) reject(error);
        else resolve();
      });
    });

    await Bun.sleep(0);
    expect(sends()).toBe(1);
    expect(settled).toBe(false);
    expect(data.resumeWrite).not.toBeNull();

    data.resumeWrite?.();
    await finished;
    expect(settled).toBe(true);
    expect(data.resumeWrite).toBeNull();
    duplex.destroy();
  });

  test("fails a pending write if the socket closes before drain", async () => {
    const { socket, data } = fakeSocket(-1);
    const duplex = createWsDuplex(socket);
    const expected = new Error("closed");
    const finished = new Promise<Error | undefined>((resolve) => {
      duplex.write(generate({ cmd: "pingresp" }), (error) => resolve(error ?? undefined));
    });

    await Bun.sleep(0);
    data.resumeWrite?.(expected);
    expect(await finished).toBe(expected);
    expect(data.resumeWrite).toBeNull();
    duplex.destroy();
  });
});
