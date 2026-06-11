'use client';

// Reactive `window.location.search` — the missing primitive behind URL-as-state
// screens (ISS-436). Next's `useSearchParams` would force a Suspense boundary
// around every caller during prerender, so instead we subscribe to the History
// API directly: `pushState`/`replaceState` are patched ONCE (first subscriber)
// to emit `forge:locationchange`, and popstate (back/forward) feeds the same
// listener. Next's client navigations land in `pushState`, so a pinned-view
// click on the SAME route now re-renders consumers instead of silently changing
// only the URL (the old hydrate-once-on-mount pattern went stale).
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
