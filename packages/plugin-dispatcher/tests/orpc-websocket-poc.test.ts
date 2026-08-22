import { RPCLink } from "@orpc/client/websocket";
import { createORPCClient } from "@orpc/client";
import { os } from "@orpc/server";
import { RPCHandler } from "@orpc/server/websocket";
import { expect, test } from "bun:test";
import { z } from "zod";

const D2H_PREFIX = "soulcloud:d2h:v1:";
const H2D_PREFIX = "soulcloud:h2d:v1:";

type Listener = (event: any) => void;

function makeServerWebSocketBridge(ws: Bun.ServerWebSocket<unknown>) {
  const listeners = new Map<string, Set<Listener>>();
  const bridge = {
    readyState: 1,
    send(data: string | Uint8Array<ArrayBuffer>) {
      return ws.send(data);
    },
    addEventListener(type: string, listener: Listener) {
      let set = listeners.get(type);
      if (!set) listeners.set(type, set = new Set());
      set.add(listener);
    },
    removeEventListener(type: string, listener: Listener) {
      listeners.get(type)?.delete(listener);
    },
    dispatch(type: string, event: unknown) {
      for (const listener of listeners.get(type) ?? []) listener(event);
    },
    close() {
      bridge.readyState = 3;
      bridge.dispatch("close", { code: 1000, reason: "closed" });
    },
  };
  return bridge;
}

test("oRPC v2 supports reverse calls on one prefixed WebSocket", async () => {
  type DispatcherContext = { reverse: (value: string) => Promise<string> };
  const dispatcherRouter = {
    reverse: os
      .$context<DispatcherContext>()
      .input(z.object({ value: z.string() }))
      .handler(async ({ input, context }) => context.reverse(input.value)),
  };
  const hostRouter = {
    outer: os
      .$context<{ reverse: (value: string) => Promise<string> }>()
      .input(z.object({ value: z.string() }))
      .handler(async ({ input, context }: { input: { value: string }, context: { reverse: (value: string) => Promise<string> } }) => ({
        value: await context.reverse(input.value),
      })),
  };

  const dispatcherHandler = new RPCHandler(dispatcherRouter, {
    encodePeerMessage: { prefix: H2D_PREFIX },
    decodePeerMessage: { prefix: H2D_PREFIX },
  });
  const hostHandler = new RPCHandler(hostRouter, {
    encodePeerMessage: { prefix: D2H_PREFIX },
    decodePeerMessage: { prefix: D2H_PREFIX },
  });

  let hostBridge: ReturnType<typeof makeServerWebSocketBridge> | undefined;
  let dispatcherClient: ReturnType<typeof createORPCClient<typeof dispatcherRouter>> | undefined;
  let server: Bun.Server<unknown> | undefined;

  server = Bun.serve({
    port: 0,
    fetch(req, currentServer) {
      if (currentServer.upgrade(req)) return;
      return new Response("upgrade required", { status: 426 });
    },
    websocket: {
      open(ws) {
        hostBridge = makeServerWebSocketBridge(ws);
        const reverseLink = new RPCLink({
          connect: () => hostBridge as any,
          encodePeerMessage: { prefix: H2D_PREFIX },
          decodePeerMessage: { prefix: H2D_PREFIX },
        });
        dispatcherClient = createORPCClient(reverseLink);
      },
      message(ws, message) {
        if (!hostBridge) throw new Error("bridge not initialized");
        hostBridge.dispatch("message", { data: message });
        void hostHandler.message(ws, message, {
          context: { reverse: (value: string) => dispatcherClient!.reverse({ value }) },
        });
      },
      close() {
        hostBridge?.close();
        void hostHandler.close(hostBridge as any);
      },
    },
  });

  try {
    const clientSocket = new WebSocket(`ws://127.0.0.1:${server.port}`);
    const dispatcherLink = new RPCLink({
      connect: () => clientSocket,
      encodePeerMessage: { prefix: D2H_PREFIX },
      decodePeerMessage: { prefix: D2H_PREFIX },
    });
    const hostClient = createORPCClient(dispatcherLink);
    clientSocket.addEventListener("message", (event) => {
      void dispatcherHandler.message(clientSocket as any, event.data, {
        context: { reverse: async (value: string) => value },
      });
    });

    const result = await hostClient.outer({ value: "ping" });
    expect(result).toEqual({ value: "ping" });
  } finally {
    server?.stop(true);
  }
});
