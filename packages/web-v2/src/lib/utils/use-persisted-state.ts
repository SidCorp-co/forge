'use client';

// Generic localStorage-backed state for web-v2 shell preferences.
//
// SSR-safe: returns `initial` on the server and the first client render, then
// hydrates from localStorage in an effect after mount (mirrors the original
// `features/projects/pins.ts` pattern). Cross-tab sync via the `storage` event.
//
// All keys are namespaced `web-v2:<feature>` so a future per-user server sync
// can POST one flat map per feature without colliding with other apps' keys.
import { useCallback, useEffect, useRef, useState } from 'react';

export const WEB_V2_NS = 'web-v2:';

function read<T>(key: string, initial: T): T {
  if (typeof window === 'undefined') return initial;
  try {
    const raw = window.localStorage.getItem(key);
    if (raw == null) return initial;
    return JSON.parse(raw) as T;
  } catch {
    return initial;
  }
}

/**
 * `usePersistedState('web-v2:density', 'comfortable')` → `[value, setValue]`.
 * `setValue` accepts a value or an updater, like `useState`. Writes are
 * best-effort (quota / disabled storage is swallowed). Other tabs stay in sync.
 *
 * `opts.syncTabs` (default `true`) controls whether writes made in OTHER tabs
 * are adopted into this tab via the `storage` event. Set it `false` for
 * per-tab UI state that should survive a reload of *this* tab but NOT follow
 * other open tabs — e.g. an on-demand drawer/dock open flag, where adopting a
 * sibling tab's "open" would pop the panel up in every tab at once.
 */
export function usePersistedState<T>(
  key: string,
  initial: T,
  opts?: { syncTabs?: boolean },
): [T, (value: T | ((prev: T) => T)) => void] {
  const syncTabs = opts?.syncTabs ?? true;
  const [value, setValue] = useState<T>(initial);
  // Keep the freshest value in a ref so the functional updater can read it
  // without re-subscribing the storage listener.
  const valueRef = useRef(value);
  valueRef.current = value;

  // Hydrate after mount (localStorage is unavailable during SSR).
  useEffect(() => {
    const stored = read(key, initial);
    setValue(stored);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  // Cross-tab sync: adopt writes made to the same key in other tabs.
  // Skipped when `syncTabs` is false so per-tab UI state stays independent.
  useEffect(() => {
    if (!syncTabs) return;
    function onStorage(e: StorageEvent) {
      if (e.key !== key) return;
      if (e.newValue == null) {
        setValue(initial);
        return;
      }
      try {
        setValue(JSON.parse(e.newValue) as T);
      } catch {
        /* ignore malformed payloads from other tabs */
      }
    }
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, syncTabs]);

  const set = useCallback(
    (next: T | ((prev: T) => T)) => {
      setValue((prev) => {
        const resolved =
          typeof next === 'function' ? (next as (p: T) => T)(prev) : next;
        try {
          window.localStorage.setItem(key, JSON.stringify(resolved));
        } catch {
          /* best-effort: quota / disabled storage */
        }
        return resolved;
      });
    },
    [key],
  );

  return [value, set];
}
