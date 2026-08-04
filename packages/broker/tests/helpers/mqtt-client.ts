/**
 * Test helper: a minimal MQTT client over WebSocket for Bun.
 *
 * mqtt.js's WebSocket transport depends on the `ws` package which is not
 * fully supported under Bun (createWebSocketStream throws), so tests use
 * Bun's native WebSocket plus the pure-JS `mqtt-packet` codec instead.
 *
 * Supports the subset used by the broker tests: connect, subscribe,
 * publish, message events, disconnect, and error/close events.
 */

import { EventEmitter } from "node:events";
import mqttpacket from "mqtt-packet";

// mqtt-packet 9.x exposes a streaming parser() instead of a one-shot parse()
const { generate, parser } = mqttpacket as unknown as {
  generate: (packet: Record<string, unknown>) => Buffer;
  parser: () => {
    parse: (buf: Buffer) => void;
    on: (event: "packet", cb: (packet: Record<string, unknown>) => void) => void;
  };
};

export interface MqttTestClientOptions {
  clientId: string;
  username?: string;
  password?: string;
  keepalive?: number;
}

export class MqttTestClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private packetId = 1;
  private pendingSub: { packetId: number; resolve: () => void; reject: (e: Error) => void } | null = null;
  connected = false;

  constructor(
    private readonly url: string,
    private readonly options: MqttTestClientOptions,
  ) {
    super();
  }

  /** Connects (sends CONNECT, resolves on CONNACK returnCode 0). */
  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;
      ws.binaryType = "arraybuffer";
      ws.onopen = () => {};

      // stream the MQTT packets received on this connection
      const packetParser = parser();
      const handlePacket = (packet: Record<string, unknown>) => {
        if (packet.cmd === "connack") {
          if (packet.returnCode === 0) {
            clearTimeout(timeout);
            this.connected = true;
            this.emit("connect");
            resolve();
          } else {
            clearTimeout(timeout);
            const err = new Error(`connection refused (code ${packet.returnCode})`);
            this.emit("error", err);
            reject(err);
          }
          return;
        }
        if (packet.cmd === "suback" && this.pendingSub) {
          const p = this.pendingSub;
          this.pendingSub = null;
          p.resolve();
          return;
        }
        if (packet.cmd === "publish") {
          const raw = packet.payload;
          const payload = raw === undefined || raw === null ? Buffer.alloc(0) : Buffer.from(raw as Buffer);
          this.emit("message", packet.topic, payload);
          // QoS 1: acknowledge so the broker's per-device flow continues
          if (packet.qos === 1 && packet.messageId) {
            ws.send(generate({ cmd: "puback", messageId: packet.messageId }));
          }
        }
      };
      packetParser.on("packet", handlePacket);

      const timeout = setTimeout(() => reject(new Error("connect timeout")), 5000);

      ws.onopen = () => {
        ws.send(
          generate({
            cmd: "connect",
            protocolId: "MQTT",
            protocolVersion: 4,
            clean: true,
            clientId: this.options.clientId,
            keepalive: this.options.keepalive ?? 30,
            ...(this.options.username !== undefined
              ? { username: this.options.username, password: Buffer.from(this.options.password ?? "") }
              : {}),
          }),
        );
      };

      ws.onmessage = (ev) => {
        packetParser.parse(Buffer.from(ev.data));
      };

      ws.onerror = (e) => {
        clearTimeout(timeout);
        const err = new Error(`websocket error: ${(e as ErrorEvent).message ?? "unknown"}`);
        this.emit("error", err);
        reject(err);
      };

      ws.onclose = () => {
        clearTimeout(timeout);
        this.connected = false;
        // reject any in-flight operation: the broker closed the connection
        // (e.g. authorization rejection) so no SUBACK will ever arrive
        if (this.pendingSub) {
          const p = this.pendingSub;
          this.pendingSub = null;
          p.reject(new Error("connection closed"));
        }
        this.emit("close");
      };
    });
  }

  /** Subscribes to a topic (resolves on SUBACK). */
  subscribe(topic: string, _qos = 1): Promise<void> {
    return new Promise((resolve, reject) => {
      const packetId = this.packetId++;
      this.pendingSub = { packetId, resolve, reject };
      this.ws?.send(
        generate({
          cmd: "subscribe",
          messageId: packetId,
          subscriptions: [{ topic, qos: _qos }],
        }),
      );
      setTimeout(() => {
        if (this.pendingSub?.packetId === packetId) {
          this.pendingSub = null;
          reject(new Error("subscribe timeout"));
        }
      }, 5000);
    });
  }

  /** Publishes a message (resolves on send; no PUBACK tracking). */
  publish(topic: string, payload: Uint8Array, qos = 1): Promise<void> {
    return new Promise((resolve) => {
      const packetId = this.packetId++;
      this.ws?.send(
        generate({
          cmd: "publish",
          topic,
          payload: Buffer.from(payload),
          qos,
          messageId: qos > 0 ? packetId : undefined,
          dup: false,
          retain: false,
        }),
      );
      // this mini client has no reliable PUBACK tracking; resolve on send
      // (the broker test flows verify delivery via waitMessage/DB state)
      resolve();
    });
  }

  /** Waits for a message on the given topic (or any topic when null). */
  waitMessage(topic: string | null, timeoutMs = 5000): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const handler = (t: string, payload: Buffer) => {
        if (topic === null || t === topic) {
          cleanup();
          resolve(payload);
        }
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("message timeout"));
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        this.removeListener("message", handler);
      };
      this.on("message", handler);
    });
  }

  /** Closes the connection (sends DISCONNECT, then closes the socket). */
  end(): void {
    try {
      this.ws?.send(generate({ cmd: "disconnect" }));
    } catch {
      // ignore
    }
    try {
      this.ws?.close(1000);
    } catch {
      // ignore
    }
    this.connected = false;
  }
}
