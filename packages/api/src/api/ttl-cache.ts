/**
 * Minimal TTL cache used for handshake-time lookups that must not grow
 * without bound over a long-lived process (batch/job -> project id
 * caches in the WS streams). Lazy expiry: entries are dropped when read
 * past their TTL; when the entry count reaches the cap the whole cache
 * is cleared (same policy as the deviceIdCache in core logging ingest).
 */

export interface TtlCache<V> {
  get(key: string): V | undefined;
  set(key: string, value: V): void;
}

export function createTtlCache<V>(ttlMs: number, maxEntries: number): TtlCache<V> {
  const entries = new Map<string, { value: V; expiresAt: number }>();
  return {
    get(key: string): V | undefined {
      const entry = entries.get(key);
      if (!entry) return undefined;
      if (entry.expiresAt < Date.now()) {
        entries.delete(key);
        return undefined;
      }
      return entry.value;
    },
    set(key: string, value: V): void {
      if (entries.size >= maxEntries) entries.clear();
      entries.set(key, { value, expiresAt: Date.now() + ttlMs });
    },
  };
}
