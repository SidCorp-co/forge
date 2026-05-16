'use client';

import { useCallback, useSyncExternalStore } from 'react';

export interface WebUiPrefs {
  agentDrawerPinned: boolean;
}

const KEY_PREFIX = 'web.uiPrefs.';
const DEFAULTS: WebUiPrefs = {
  agentDrawerPinned: false,
};
const CHANGE_EVENT = 'web-ui-prefs-change';

function storageKey<K extends keyof WebUiPrefs>(key: K): string {
  return `${KEY_PREFIX}${String(key)}`;
}

function readPref<K extends keyof WebUiPrefs>(key: K): WebUiPrefs[K] {
  if (typeof window === 'undefined') return DEFAULTS[key];
  const raw = window.localStorage.getItem(storageKey(key));
  if (raw === null) return DEFAULTS[key];
  try {
    return JSON.parse(raw) as WebUiPrefs[K];
  } catch {
    return DEFAULTS[key];
  }
}

function subscribe(callback: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  const onStorage = (e: StorageEvent) => {
    if (e.key && e.key.startsWith(KEY_PREFIX)) callback();
  };
  const onLocal = () => callback();
  window.addEventListener('storage', onStorage);
  window.addEventListener(CHANGE_EVENT, onLocal);
  return () => {
    window.removeEventListener('storage', onStorage);
    window.removeEventListener(CHANGE_EVENT, onLocal);
  };
}

export function useUserPref<K extends keyof WebUiPrefs>(
  key: K,
): [WebUiPrefs[K], (next: WebUiPrefs[K]) => void] {
  const value = useSyncExternalStore(
    subscribe,
    () => readPref(key),
    () => DEFAULTS[key],
  );
  const setValue = useCallback(
    (next: WebUiPrefs[K]) => {
      if (typeof window === 'undefined') return;
      window.localStorage.setItem(storageKey(key), JSON.stringify(next));
      window.dispatchEvent(new Event(CHANGE_EVENT));
    },
    [key],
  );
  return [value, setValue];
}
