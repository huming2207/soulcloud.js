/**
 * Connection registry: the broker's own lookup table of live device
 * sessions and their active subscriptions.
 *
 * Why this exists: the command/OTA pollers and the credential-revocation
 * kick previously read `aedes.clients` and `client.subscriptions` — both
 * are internal aedes structures that are NOT part of its public types and
 * may change shape across upgrades without a compile error. The registry
 * is built exclusively from aedes' DOCUMENTED events ('client',
 * 'clientDisconnect', 'subscribe', 'unsubscribe') and owns the lookup
 * semantics in one place.
 *
 * Same-clientId replacement semantics (verified against aedes source):
 * aedes closes the OLD session (emitting 'clientDisconnect') BEFORE
 * registering the replacement (emitting 'client'), so entries are keyed
 * by client OBJECT REFERENCE — a disconnect only removes the entry when
 * it still belongs to the client that registered it. A plain
 * connected-flag would race the replacement window.
 */

import type { Aedes, Client } from "aedes";

export interface ConnectionRegistry {
  /** Whether the device has a live authenticated session right now. */
  isConnected(deviceUid: string): boolean;
  /** Whether the device's live session is subscribed to the exact topic. */
  isSubscribed(deviceUid: string, topic: string): boolean;
  /** The live session object (for revoke kicks), or null when offline. */
  getClient(deviceUid: string): Client | null;
  /** Number of live sessions (diagnostics). */
  readonly size: number;
}

/**
 * Attaches the registry to an aedes instance. Must be attached BEFORE the
 * broker accepts connections (the registry only observes events, so a
 * late attach simply misses earlier sessions — attach at startup).
 */
export function attachConnectionRegistry(aedes: Aedes): ConnectionRegistry {
  const byUid = new Map<string, Client>();
  const subscriptions = new Map<string, Set<string>>();

  // 'client' fires when aedes registers an AUTHENTICATED session (after
  // the CONNECT handshake's credential check); unauthenticated connects
  // never reach it, so byUid only ever holds verified devices.
  aedes.on("client", (client) => {
    byUid.set(client.id, client);
    subscriptions.set(client.id, new Set());
  });

  aedes.on("clientDisconnect", (client) => {
    // replacement guard: the old session is unregistered before the new
    // one registers; if the entry no longer points at this client, the
    // same device already reconnected and the new entry must survive
    if (byUid.get(client.id) !== client) return;
    byUid.delete(client.id);
    subscriptions.delete(client.id);
  });

  // 'subscribe' fires after aedes registered the subscription (and only
  // for authorized ones: the broker's authorizeSubscribe gate runs first).
  aedes.on("subscribe", (subs, client) => {
    const set = subscriptions.get(client.id);
    if (!set) return;
    for (const sub of subs) set.add(sub.topic);
  });

  aedes.on("unsubscribe", (topics, client) => {
    const set = subscriptions.get(client.id);
    if (!set) return;
    for (const topic of topics) set.delete(topic);
  });

  return {
    isConnected: (deviceUid) => byUid.has(deviceUid),
    isSubscribed: (deviceUid, topic) =>
      subscriptions.get(deviceUid)?.has(topic) ?? false,
    getClient: (deviceUid) => byUid.get(deviceUid) ?? null,
    get size() {
      return byUid.size;
    },
  };
}
