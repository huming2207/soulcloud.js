/**
 * Connection registry: the broker's own lookup table of live device
 * sessions and their active subscriptions.
 *
 * Why this exists: the command/OTA pollers and the credential-revocation
 * kick previously read `aedes.clients` and `client.subscriptions` — both
 * are internal aedes structures that are NOT part of its public types and
 * may change shape across upgrades without a compile error. The registry
 * is built from aedes' documented events ('client', 'clientDisconnect',
 * 'subscribe', 'unsubscribe') plus one explicit hook
 * (`noteAuthorizedSubscription`) that the broker calls from its
 * authorizeSubscribe gate.
 *
 * Persistent-session restore (clean=false): aedes restores saved
 * subscriptions WITHOUT emitting the 'subscribe' event (verified in
 * subscribe.js: the restore path runs [authorize, addSubs] and skips
 * completeSubscribe, which is the only place that emits). The restored
 * subscription DOES pass through the authorizeSubscribe hook, so the
 * broker's gate records it via noteAuthorizedSubscription — the registry
 * never reads aedes internals, and restored sessions behave exactly like
 * fresh ones.
 *
 * Same-clientId replacement semantics (verified against aedes source):
 * aedes closes the OLD session (emitting 'clientDisconnect') BEFORE
 * registering the replacement (emitting 'client'), so entries are keyed
 * by client OBJECT REFERENCE — a disconnect only removes the entry when
 * it still belongs to the client that registered it. Subscription
 * mutations carry the same reference guard so a late unsubscribe from a
 * replaced session can never touch the new session's topics.
 */

import type { Aedes, Client } from "aedes";

export interface ConnectionRegistry {
  /** Whether the device has a live authenticated session right now. */
  isConnected(deviceUid: string): boolean;
  /** Whether the device's live session is subscribed to the exact topic. */
  isSubscribed(deviceUid: string, topic: string): boolean;
  /** The live session object (for revoke kicks), or null when offline. */
  getClient(deviceUid: string): Client | null;
  /**
   * Records that the device's subscription to `topic` was AUTHORIZED.
   * The broker's authorizeSubscribe gate must call this on success — it
   * is the only signal for persistent-session restores (which skip the
   * 'subscribe' event), and it is harmless for normal subscriptions
   * (the later 'subscribe' event is idempotent).
   */
  noteAuthorizedSubscription(deviceUid: string, topic: string): void;
  /** Number of live sessions (diagnostics). */
  readonly size: number;
}

/** One live session: the client object plus its authorized topics. */
interface SessionEntry {
  client: Client;
  topics: Set<string>;
}

/**
 * Attaches the registry to an aedes instance. Must be attached BEFORE the
 * broker accepts connections (the registry only observes events, so a
 * late attach simply misses earlier sessions — attach at startup).
 */
export function attachConnectionRegistry(aedes: Aedes): ConnectionRegistry {
  const sessions = new Map<string, SessionEntry>();
  /**
   * Topics authorized BEFORE the session entry exists. Persistent-session
   * restore (clean=false) runs authorize during the CONNECT flow, BEFORE
   * aedes registers the client ('client' event); those notes land here
   * and are adopted when the entry is created.
   */
  const pendingTopics = new Map<string, Set<string>>();

  // 'client' fires when aedes registers an AUTHENTICATED session (after
  // the CONNECT handshake's credential check); unauthenticated connects
  // never reach it, so the map only ever holds verified devices.
  aedes.on("client", (client) => {
    const topics = pendingTopics.get(client.id);
    sessions.set(client.id, {
      client,
      topics: topics ?? new Set(),
    });
    pendingTopics.delete(client.id);
  });

  aedes.on("clientDisconnect", (client) => {
    // replacement guard: the old session is unregistered before the new
    // one registers; if the entry no longer points at this client, the
    // same device already reconnected and the new entry must survive
    const entry = sessions.get(client.id);
    if (!entry || entry.client !== client) return;
    sessions.delete(client.id);
  });

  // 'subscribe' fires after aedes registered the subscription (and only
  // for authorized ones: the broker's authorizeSubscribe gate runs first).
  // Entries with qos >= 128 were NOT granted (protocol-level failures,
  // MQTT 3.1.1 §3.9.3) and must not be tracked.
  aedes.on("subscribe", (subs, client) => {
    const entry = sessions.get(client.id);
    if (!entry || entry.client !== client) return;
    for (const sub of subs) {
      if (typeof sub.qos === "number" && sub.qos >= 128) continue;
      entry.topics.add(sub.topic);
    }
  });

  aedes.on("unsubscribe", (topics, client) => {
    const entry = sessions.get(client.id);
    if (!entry || entry.client !== client) return;
    for (const topic of topics) entry.topics.delete(topic);
  });

  return {
    isConnected: (deviceUid) => sessions.has(deviceUid),
    isSubscribed: (deviceUid, topic) =>
      sessions.get(deviceUid)?.topics.has(topic) ?? false,
    getClient: (deviceUid) => sessions.get(deviceUid)?.client ?? null,
    noteAuthorizedSubscription: (deviceUid, topic) => {
      const entry = sessions.get(deviceUid);
      if (entry) {
        entry.topics.add(topic);
        return;
      }
      // pre-registration (restore path): buffer until 'client' fires
      let pending = pendingTopics.get(deviceUid);
      if (!pending) {
        pending = new Set();
        pendingTopics.set(deviceUid, pending);
      }
      pending.add(topic);
    },
    get size() {
      return sessions.size;
    },
  };
}
