import { describe, expect, test } from "bun:test";
import { splitArtifactBody } from "../src/manager";

describe("plugin artifact upload body", () => {
  test("stops reading a stalled body at the absolute upload deadline", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull: () => new Promise<void>(() => {}),
      cancel: () => { cancelled = true; },
    });
    const read = (async () => {
      for await (const _chunk of splitArtifactBody(body, performance.now() + 10)) {
        // The body never yields a chunk.
      }
    })();

    await expect(read).rejects.toMatchObject({ status: 504, publicCode: "plugin_timeout" });
    expect(cancelled).toBe(true);
  });

  test("splits a body into bounded chunks", async () => {
    const first = Uint8Array.from({ length: 65_536 }, (_, index) => index & 0xff);
    const second = Uint8Array.of(1, 2, 3);
    const chunks: Uint8Array[] = [];
    for await (const chunk of splitArtifactBody(new ReadableStream({
      start(controller) {
        controller.enqueue(first);
        controller.enqueue(second);
        controller.close();
      },
    }), performance.now() + 1_000)) {
      chunks.push(chunk);
    }
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toEqual(first);
    expect(chunks[1]).toEqual(second);
  });
});
