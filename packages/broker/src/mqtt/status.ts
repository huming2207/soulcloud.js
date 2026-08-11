/**
 * Device online/offline status notifications (device-status stream).
 *
 * The broker process notifies the web console's status channel on connect
 * and disconnect. A same-clientId reconnection (session replacement) must
 * NOT emit a false offline event: aedes closes the old session when the
 * new one registers, and the UI would otherwise show a device offline
 * that is actively connected.
 *
 * Aedes offers no reliable way to distinguish a replaced session from a
 * real disconnect at the moment `clientDisconnect` fires (the old session
 * is unregistered — and thus removed from `aedes.clients` — before the
 * event, and the replacement's `client` event arrives only after the old
 * session's close completes). So offline is deferred: if the same clientId
 * reconnects within the window, the pending offline event is cancelled.
 * The delay is the same order of magnitude as the API-side per-device
 * debounce, and the UI falls back to stat freshness anyway.
 */

import type { Aedes, Client } from "aedes";

export type StatusNotify = (deviceUid: string, online: boolean) => void;

/** How long a disconnect waits for a same-clientId reconnect before the
 *  device is reported offline. */
const OFFLINE_DEFER_MS = 300;

/**
 * Wires aedes connect/disconnect events to a status notifier.
 *
 * Exported separately from the process entry point so the replacement
 * suppression can be tested against a real broker without booting the
 * whole process.
 */
export function attachDeviceStatusNotifications(
  aedes: Aedes,
  notify: StatusNotify,
): void {
  // deviceUid -> pending offline timer (set on disconnect, cancelled on
  // reconnect)
  const pending = new Map<string, ReturnType<typeof setTimeout>>();

  aedes.on("client", (client) => {
    const timer = pending.get(client.id);
    if (timer) {
      // the device reconnected inside the offline window: it never went
      // offline
      clearTimeout(timer);
      pending.delete(client.id);
    }
    notify(client.id, true);
  });
  aedes.on("clientDisconnect", (client: Client) => {
    const timer = pending.get(client.id);
    if (timer) clearTimeout(timer); // repeated disconnect: restart the window
    pending.set(
      client.id,
      setTimeout(() => {
        pending.delete(client.id);
        // no same-clientId reconnect within the window: truly offline
        notify(client.id, false);
      }, OFFLINE_DEFER_MS),
    );
  });
}
