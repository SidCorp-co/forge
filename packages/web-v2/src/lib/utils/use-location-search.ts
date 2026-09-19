'use client';

import { useSyncExternalStore } from 'react';

const EVENT = 'forge:locationchange';

let patched = false;
function patchHistory() {
  if (patched || typeof window === 'undefined') return;
  patched = true;
  for (const method of ['pushState', 'replaceState'] as const) {
    const original = window.history[method].bind(window.history);
    window.history[method] = (...args: Parameters<History['pushState']>) => {
      original(...args);
      window.dispatchEvent(new Event(EVENT));
    };
  }
}

function subscribe(onChange: () => void): () => void {
  patchHistory();
  window.addEventListener(EVENT, onChange);
  window.addEventListener('popstate', onChange);
  return () => {
    window.removeEventListener(EVENT, onChange);
    window.removeEventListener('popstate', onChange);
  };
}

const getSnapshot = () => window.location.search;
const getServerSnapshot = () => '';

/** Current `window.location.search` (leading `?`, or `''`) — reactive across
 *  pushState / replaceState / popstate. */
export function useLocationSearch(): string {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
