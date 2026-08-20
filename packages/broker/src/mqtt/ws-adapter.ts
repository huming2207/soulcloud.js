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
  server: { stop: (closeActive?: boolean) => Promise<void> };
  port: number;
}

interface WsConnectionData {
  duplex: Duplex | null;
  /** Completes the active Duplex write when Bun reports the socket drained. */
  resumeWrite: ((error?: Error) => void) | null;
  /** Partial MQTT bytes carried across WS message boundaries. */
  partial: { chunks: Buffer[]; length: number } | null;
  /** Absolute ceiling for one declared MQTT frame (early DoS guard). */
  maxPacketBytes: number;
}

type ServerWebSocket = import("bun").ServerWebSocket<WsConnectionData>;

/**
 * Default ceiling for one declared MQTT frame, enforced BEFORE the bytes
 * reach mqtt-packet. The parser buffers a payload according to its
 * declared remaining length (up to ~268MB); without this pre-scan a
 * hostile or broken device can declare a huge length and OOM the broker
 * before `authorizePublish` ever runs. 256KB matches the broker's
 * MAX_PUBLISH_BYTES early-reject ceiling.
 */
export const DEFAULT_MAX_FRAME_BYTES = 256 * 1024;

type MqttScanResult =
  | { kind: "incomplete" }
  | { kind: "frame"; total: number }
  | { kind: "malformed" };

/**
 * Scans ONE MQTT fixed header at the start of `buf` and returns the total
 * frame length (1 type byte + varint bytes + remaining length).
 * `incomplete` = need more bytes; `malformed` = varint continuation
 * beyond 4 bytes (invalid per MQTT 3.1.1/5.0).
 */
function scanMqttFrameLength(buf: Uint8Array): MqttScanResult {
  if (buf.length < 2) return { kind: "incomplete" };
  let i = 1;
  let remainingLen = 0;
  let multiplier = 1;
  while (i < buf.length) {
    const b = buf[i]!;
    remainingLen += (b & 0x7f) * multiplier;
    if ((b & 0x80) === 0) {
      return { kind: "frame", total: 1 + i + remainingLen };
    }
    multiplier *= 128;
    i++;
    if (i > 4) return { kind: "malformed" };
  }
  return { kind: "incomplete" };
}

/** Creates and starts the MQTT-over-WebSocket broker endpoint. */
export function startWsBroker(
  aedes: Aedes,
  options: WsBrokerOptions & { maxPacketBytes?: number },
): Promise<WsBrokerHandle> {
  const maxPacketBytes = options.maxPacketBytes ?? DEFAULT_MAX_FRAME_BYTES;
  return new Promise((resolve, reject) => {
    const server = Bun.serve<WsConnectionData>({
      port: options.port,
      fetch(req, srv) {
        const url = new URL(req.url);
        if (url.pathname !== options.path) {
          return new Response("not found", { status: 404 });
        }
        if (!srv.upgrade(req, {
          data: { duplex: null, resumeWrite: null, partial: null, maxPacketBytes },
        })) {
          return new Response("upgrade failed", { status: 400 });
        }
        return undefined;
      },
      websocket: {
        // MQTT carries its own keepalive (device CONNECT keepalive, checked
        // by aedes), so Bun's ws-level ping/pong is redundant and harmful on
        // slow clients (an emulated device under host CPU pressure can miss
        // the pong deadline and get its healthy connection torn down).
        sendPings: false,
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
          if (bytes.length === 0) return;

          // Early frame pre-scan (S-audit): MQTT-over-WS allows several
          // complete packets per WS message AND packets split across WS
          // messages. mqtt-packet buffers a payload to its full declared
          // remaining length before authorizePublish can reject it, so a
          // malicious (even unauthenticated) device could declare ~268MB
          // and OOM the broker. Reject oversized/malformed declared frames
          // here, before any byte reaches the parser.
          const partial = ws.data.partial;
          let buf: Buffer;
          if (partial && partial.chunks.length > 0) {
            partial.chunks.push(bytes);
            partial.length += bytes.length;
            buf = Buffer.concat(partial.chunks);
          } else {
            buf = bytes;
          }

          let offset = 0;
          for (;;) {
            const rest = buf.subarray(offset);
            const scan = scanMqttFrameLength(rest);
            if (scan.kind === "incomplete") break;
            if (scan.kind === "malformed" || scan.total > ws.data.maxPacketBytes) {
              ws.data.partial = null;
              try {
                ws.close();
              } catch {
                // already closing
              }
              return;
            }
            if (scan.total > rest.length) break;
            offset += scan.total;
          }

          if (offset === 0) {
            // no complete frame yet: buffer everything for the next message
            if (!partial) {
              ws.data.partial = { chunks: [bytes], length: bytes.length };
            }
            return;
          }
          if (offset < buf.length) {
            // Copy only the incomplete tail. Keeping a subarray would retain
            // the entire (possibly large) WS message until the next fragment.
            const tail = Buffer.from(buf.subarray(offset));
            ws.data.partial = { chunks: [tail], length: tail.length };
          } else {
            ws.data.partial = null;
          }
          if (!duplex.push(buf.subarray(0, offset))) {
            // readable side is saturated; aedes backpressure will drain it
          }
        },
        drain(ws: ServerWebSocket) {
          const resumeWrite = ws.data.resumeWrite;
          if (resumeWrite) resumeWrite();
        },
        close(ws: ServerWebSocket, code: number, reason: string) {
          // code 0 = the peer went away without a close frame (TCP
          // FIN/RST); code 1000 = we called ws.close() ourselves via the
          // duplex teardown. Distinguishing the direction is essential
          // for attributing reconnect storms.
          console.log(`[soulcloud-broker] ws closed code=${code} reason=${reason}`);
          const duplex = ws.data.duplex;
          ws.data.duplex = null;
          ws.data.partial = null;
          const resumeWrite = ws.data.resumeWrite;
          if (resumeWrite) {
            resumeWrite(new Error("websocket closed before buffered data drained"));
          }
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

    // Bun.serve resolves once listening; surface the handle immediately.
    // The port is the ACTUAL bound port (port: 0 asks for a free one,
    // which tests rely on).
    resolve({
      server: { stop: (closeActive = false) => server.stop(closeActive) },
      port: server.port ?? options.port,
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
  private buf: Buffer<ArrayBufferLike> = Buffer.alloc(0);

  push(chunk: Buffer, onFrame: (frame: Buffer) => void): void {
    // createWsDuplex already gives us an owned copy, so copying the first
    // chunk again only adds allocation and memory bandwidth on every frame.
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
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
  const scan = scanMqttFrameLength(buf);
  if (scan.kind === "incomplete") return null;
  if (scan.kind === "malformed") {
    // write-side frames come from mqtt-packet and are always well-formed;
    // this is defensive only - a malformed varint here would otherwise
    // never drain and grow the buffer without bound
    throw new Error("malformed MQTT varint on the write side");
  }
  return scan.total <= buf.length ? scan.total : null;
}

/** Bridges a Bun server WebSocket to a Duplex for aedes.handle. */
/** @internal Exported for transport-level backpressure regression tests. */
export function createWsDuplex(ws: ServerWebSocket): Duplex {
  const framer = new MqttFrameBuffer();
  const duplex = new Duplex({
    read() {
      // push() is driven from the message handler; nothing to do here
    },
    write(chunk, _encoding, callback) {
      try {
        const data = Buffer.isBuffer(chunk) ? Buffer.from(chunk) : Buffer.from(chunk as Uint8Array);
        let sendError: Error | null = null;
        let backpressured = false;
        framer.push(data, (frame) => {
          // Bun's ws.send returns: >=0 bytes queued, -1 when the message was
          // queued with backpressure (NOT a failure - the frame is still
          // sent once the socket drains), and 0 when the connection is
          // unusable (closed). Only 0 is a real failure; reporting -1 as an
          // error made aedes tear down healthy connections under load.
          if (sendError !== null) return;
          const sent = ws.send(frame);
          if (sent === 0) {
            sendError = new Error("websocket send failed; connection unusable");
          } else if (sent === -1) {
            backpressured = true;
          }
        });
        if (sendError) {
          callback(sendError);
        } else if (backpressured) {
          // Node Writable streams serialize _write calls until callback.
          // Holding it until Bun's drain event prevents Aedes from growing
          // the per-connection WebSocket queue without bound.
          ws.data.resumeWrite = (error?: Error) => {
            if (!ws.data.resumeWrite) return;
            ws.data.resumeWrite = null;
            callback(error ?? null);
          };
        } else {
          callback(null);
        }
      } catch (error) {
        callback(error as Error);
      }
    },
  });

  // aedes destroys the stream on protocol errors and disconnects; that
  // fires the 'close' event, not 'final', so the WS must be closed here
  let wsClosing = false;
  const closeWs = (why: string) => {
    if (wsClosing) return;
    wsClosing = true;
    console.log(`[soulcloud-broker] duplex closed (${why}); closing ws`);
    try {
      ws.close();
    } catch {
      // already closed
    }
  };
  duplex.on("end", () => closeWs("peer FIN"));
  duplex.on("close", () => closeWs("duplex close"));
  duplex.on("error", (e) => closeWs(`error: ${(e as Error).message}`));

  return duplex;
}
