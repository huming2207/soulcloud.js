import type {
  PluginContext,
  PluginEventInput,
  PluginEventResult,
  PluginWorker,
} from "@soulcloud/plugin-sdk";

interface ChaosPayload {
  value?: number;
  updates?: Array<{
    entityKey: string;
    value?: unknown;
    quality?: string;
  }>;
  ms?: number;
}

function payloadOf(event: PluginEventInput): ChaosPayload {
  return (event.payload ?? {}) as ChaosPayload;
}

function sleepOrAbort(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(new Error("aborted by dispatcher deadline"));
    }
    if (signal.aborted) {
      clearTimeout(timer);
      reject(new Error("aborted by dispatcher deadline"));
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Deliberately bad worker; this module is loaded only in a Plugin Host container. */
export const chaosTestWorker: PluginWorker = {
  async onEvent(
    ctx: PluginContext,
    event: PluginEventInput,
  ): Promise<PluginEventResult> {
    const payload = payloadOf(event);
    switch (event.eventKind) {
      case "ok":
        return {
          updates: [
            { entityKey: "chaos.counter", value: payload.value ?? 1 },
            { entityKey: "chaos.last_kind", value: "ok" },
          ],
        };
      case "reverse": {
        const snapshot = await ctx.entities.get("chaos.counter");
        await ctx.commands.enqueueCommand("chaos_reverse", [{
          value: typeof snapshot?.value === "number" ? snapshot.value : 0,
        }]);
        return {
          updates: [{ entityKey: "chaos.last_kind", value: "reverse" }],
        };
      }
      case "unawaited":
        void ctx.entities.get("chaos.counter").catch(() => undefined);
        return { updates: [{ entityKey: "chaos.last_kind", value: "unawaited" }] };
      case "updates":
        return {
          updates: (payload.updates ?? []) as PluginEventResult["updates"],
        };
      case "fail":
        throw new Error(
          payload.value !== undefined
            ? `chaos failure #${payload.value}`
            : "chaos failure",
        );
      case "crash":
        console.error("[chaos] crashing host process by request");
        process.exit(70);
        break;
      case "hang":
        while (true) {
          Math.random();
        }
      case "oom": {
        const chunks: Uint8Array[] = [];
        for (;;) chunks.push(new Uint8Array(32 * 1024 * 1024));
      }
      case "huge":
        return {
          updates: [
            {
              entityKey: "chaos.last_kind",
              value: "x".repeat(16 * 1024 * 1024),
            },
          ],
        };
      case "bulky":
        return {
          updates: [
            { entityKey: "chaos.last_kind", value: "y".repeat(15 * 1024) },
          ],
        };
      case "slow":
        await sleepOrAbort(payload.ms ?? 10_000, ctx.signal);
        return {
          updates: [{ entityKey: "chaos.last_kind", value: "slow-ok" }],
        };
      default:
        throw new Error(
          `chaos plugin received unknown event kind "${event.eventKind}"`,
        );
    }
  },
};
