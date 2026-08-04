/**
 * MQTT over WebSocket transport for the embedded Aedes broker, built on
 * Bun's native WebSocket implementation.
 *
 * The `ws` npm package (used by aedes-server-factory / websocket-stream) is
 * not fully supported under Bun (createWebSocketStream throws), so this
 * adapter bridges Bun's WebSocket messages to a Node-style Duplex stream
 * which is exactly what `aedes.handle` expects:
 *
 *   - binary WS messages are pushed into the readable side
 *   - writes to the stream are sent as binary WS frames
 *   - close/error on either side destroys the other
 *
 * The upgrade flow: `Bun.serve` upgrades the HTTP request; the `open`
 * handler creates the Duplex and hands it to `aedes.handle`.
 */

import { Duplex } from "node:stream";
import type { Aedes } from "aedes";

export interface WsBrokerOptions {
  /** Port to listen on. */
  port: number;
  /** WebSocket path, e.g. "/mqtt". */
  path: string;
}

export interface WsBrokerHandle {
  server: { stop: (closeActive?: boolean) => void };
  port: number;
}

interface WsConnectionData {
  duplex: Duplex | null;
}

type ServerWebSocket = import("bun").ServerWebSocket<WsConnectionData>;

/** Creates and starts the MQTT-over-WebSocket broker endpoint. */
export function startWsBroker(
  aedes: Aedes,
  options: WsBrokerOptions,
): Promise<WsBrokerHandle> {
  return new Promise((resolve, reject) => {
    const server = Bun.serve<WsConnectionData>({
      port: options.port,
      fetch(req, srv) {
        const url = new URL(req.url);
        if (url.pathname !== options.path) {
          return new Response("not found", { status: 404 });
        }
        if (!srv.upgrade(req, { data: { duplex: null } })) {
          return new Response("upgrade failed", { status: 400 });
        }
        return undefined;
      },
      websocket: {
        open(ws: ServerWebSocket) {
          const duplex = createWsDuplex(ws);
          ws.data.duplex = duplex;
          aedes.handle(duplex);
        },
        message(ws: ServerWebSocket, message) {
          const duplex = ws.data.duplex;
          if (!duplex) return;
          const bytes =
            typeof message === "string"
              ? Buffer.from(message)
              : Buffer.isBuffer(message)
                ? message
                : Buffer.from(message);
          if (!duplex.push(bytes)) {
            // readable side is saturated; aedes backpressure will drain it
          }
        },
        close(ws: ServerWebSocket) {
          const duplex = ws.data.duplex;
          ws.data.duplex = null;
          if (duplex) {
            duplex.destroy();
          }
        },
      },
      error(error) {
        // listen errors (e.g. EADDRINUSE) surface here before any request
        reject(error);
      },
    });

    // Bun.serve resolves once listening; surface the handle immediately
    resolve({
      server: { stop: (closeActive = false) => server.stop(closeActive) },
      port: options.port,
    });
  });
}

/**
 * MQTT-over-WebSocket framing buffer.
 *
 * The spec requires one complete MQTT control packet per WS data frame,
 * but mqtt-packet's writeToStream emits a packet as several stream.write()
 * calls (header, flags, payload). This buffer reassembles the writes into
 * complete packets before they are sent.
 */
class MqttFrameBuffer {
  private buf = Buffer.alloc(0);

  push(chunk: Buffer, onFrame: (frame: Buffer) => void): void {
    this.buf = this.buf.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.buf, chunk]);
    for (;;) {
      const frameLen = mqttFrameLength(this.buf);
      if (frameLen === null) break; // incomplete
      onFrame(this.buf.subarray(0, frameLen));
      this.buf = this.buf.subarray(frameLen);
    }
  }
}

/** Returns the complete frame length for a buffered MQTT packet, or null. */
function mqttFrameLength(buf: Buffer): number | null {
  if (buf.length < 2) return null;
  let i = 1;
  let remainingLen = 0;
  let multiplier = 1;
  while (i < buf.length) {
    const b = buf[i]!;
    remainingLen += (b & 0x7f) * multiplier;
    if ((b & 0x80) === 0) break;
    multiplier *= 128;
    i++;
    if (i > 4) return null; // malformed varint
  }
  if (i >= buf.length) return null; // varint incomplete
  const total = 1 + i + remainingLen; // type byte + varint bytes + payload
  return total <= buf.length ? total : null;
}

/** Bridges a Bun server WebSocket to a Duplex for aedes.handle. */
function createWsDuplex(ws: ServerWebSocket): Duplex {
  const framer = new MqttFrameBuffer();
  const duplex = new Duplex({
    read() {
      // push() is driven from the message handler; nothing to do here
    },
    write(chunk, _encoding, callback) {
      try {
        const data = Buffer.isBuffer(chunk) ? Buffer.from(chunk) : Buffer.from(chunk as Uint8Array);
        let sendError: Error | null = null;
        framer.push(data, (frame) => {
          // backpressure: Bun's ws.send returns -1 when the socket buffer is
          // full (frame dropped) - report it so aedes does not believe the
          // QoS1 packet was delivered
          if (sendError === null && ws.send(frame) < 0) {
            sendError = new Error("websocket send buffer full; frame dropped");
          }
        });
        callback(sendError);
      } catch (error) {
        callback(error as Error);
      }
    },
  });

  // aedes destroys the stream on protocol errors and disconnects; that
  // fires the 'close' event, not 'final', so the WS must be closed here
  const closeWs = () => {
    try {
      ws.close();
    } catch {
      // already closed
    }
  };
  duplex.on("close", closeWs);
  duplex.on("error", closeWs);

  return duplex;
}
