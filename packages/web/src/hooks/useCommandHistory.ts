/**
 * Per-device command input history (zsh-style ArrowUp/ArrowDown).
 *
 * Semantics mirror a shell history:
 *   - ArrowUp walks from the most recent entry towards the oldest; the
 *     in-progress draft is preserved and restored when reaching the bottom
 *   - ArrowDown walks back towards the draft
 *   - a committed command is appended (consecutive repeats are not
 *     recorded twice), capped per device, persisted in localStorage
 *
 * Storage: one key per device (`soulcloud.cmdhistory.<deviceId>`), so
 * history never leaks across devices or projects.
 */
import { useCallback, useState } from "react";

const STORAGE_PREFIX = "soulcloud.cmdhistory.";
const DEFAULT_MAX = 50;

function load(id: string): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + id);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((s): s is string => typeof s === "string");
  } catch {
    return [];
  }
}

export interface CommandHistory {
  /** All recorded entries, oldest -> newest. */
  entries: string[];
  /** ArrowUp: older entry, or null when already at the oldest / empty. */
  up: (current: string) => string | null;
  /** ArrowDown: newer entry, or the draft when at the newest / idle. */
  down: () => string | null;
  /** Records a submitted command (dedupe + cap + persist). */
  commit: (cmd: string) => void;
}

export function useCommandHistory(deviceId: string, max = DEFAULT_MAX): CommandHistory {
  const [entries, setEntries] = useState<string[]>(() => load(deviceId));
  // index into `entries` while navigating; -1 = not navigating (draft mode)
  const [index, setIndex] = useState(-1);
  const [draft, setDraft] = useState("");

  const storageKey = STORAGE_PREFIX + deviceId;

  const up = useCallback(
    (current: string): string | null => {
      if (entries.length === 0) return null;
      if (index === -1) {
        setDraft(current);
        setIndex(entries.length - 1);
        return entries[entries.length - 1]!;
      }
      if (index === 0) return null; // already at the oldest entry
      setIndex(index - 1);
      return entries[index - 1]!;
    },
    [entries, index],
  );

  const down = useCallback((): string | null => {
    if (index === -1) return null; // idle; nothing to walk back to
    if (index >= entries.length - 1) {
      // reached the newest: restore the draft and leave navigation
      setIndex(-1);
      return draft;
    }
    setIndex(index + 1);
    return entries[index + 1]!;
  }, [entries, index, draft]);

  const commit = useCallback(
    (cmd: string) => {
      const trimmed = cmd.trim();
      if (!trimmed) return;
      setEntries((prev) => {
        const next =
          prev.length > 0 && prev[prev.length - 1] === trimmed
            ? prev
            : [...prev, trimmed].slice(-max);
        try {
          localStorage.setItem(storageKey, JSON.stringify(next));
        } catch {
          // storage unavailable (private mode etc.): keep in-memory only
        }
        return next;
      });
      setIndex(-1);
      setDraft("");
    },
    [max, storageKey],
  );

  return { entries, up, down, commit };
}
