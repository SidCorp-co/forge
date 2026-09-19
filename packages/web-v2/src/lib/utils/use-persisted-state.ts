'use client';

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

function readPerTab<T>(key: string, initial: T): T {
  if (typeof window === 'undefined') return initial;
  try {
    const session = window.sessionStorage.getItem(key);
    if (session != null) return JSON.parse(session) as T;
  } catch {
    /* fall through to the localStorage seed */
  }
  // No per-tab value yet: seed once from the shared localStorage value (the
  // most-recently-used value across all tabs) and capture it into this tab's
  // sessionStorage so future reads/reloads of this tab are stable.
  const seeded = read(key, initial);
  try {
    window.sessionStorage.setItem(key, JSON.stringify(seeded));
  } catch {
    /* best-effort: quota / disabled storage */
  }
  return seeded;
}

export function usePerTabState<T>(
  key: string,
  initial: T,
): [T, (value: T | ((prev: T) => T)) => void] {
  const [value, setValue] = useState<T>(initial);

  // Hydrate after mount (storage is unavailable during SSR).
  useEffect(() => {
    setValue(readPerTab(key, initial));
  }, [key]);

  const set = useCallback(
    (next: T | ((prev: T) => T)) => {
      setValue((prev) => {
        const resolved =
          typeof next === 'function' ? (next as (p: T) => T)(prev) : next;
        try {
          window.sessionStorage.setItem(key, JSON.stringify(resolved));
        } catch {
          /* best-effort: quota / disabled storage */
        }
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
