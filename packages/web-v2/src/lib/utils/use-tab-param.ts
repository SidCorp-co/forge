'use client';

// Mirror an active tab into the `?tab=` query param without a navigation /
// refetch (shallow replaceState). The tab is DERIVED from the URL — reactive
// via `useLocationSearch` — so external URL changes (a pinned-view click on the
// same route, back/forward, a deep-link push) update the screen without a
// remount (ISS-436; the old hydrate-once useState went stale). The
// first/default tab is represented as a bare URL (no `?tab=`). Shared by the
// merged screen shells (Agents · Library · Automation) + the Issues screen.
import { useCallback } from 'react';
import { usePathname } from 'next/navigation';
import { useLocationSearch } from './use-location-search';

export function useTabParam<T extends string>(valid: readonly T[], fallback: T): [T, (t: T) => void] {
  const pathname = usePathname() || '';
  const search = useLocationSearch();

  const raw = new URLSearchParams(search).get('tab');
  const tab = raw && (valid as readonly string[]).includes(raw) ? (raw as T) : fallback;

  const setTab = useCallback(
    (next: T) => {
      if (typeof window === 'undefined') return;
      // Mutate only the `tab` key — preserve every other query param (e.g. the
      // `?issue=` filter the Agents screen reads). Rebuilding the string from
      // scratch here previously wiped sibling params on mount (ISS-331 AC3).
      const sp = new URLSearchParams(window.location.search);
      if (next === fallback) sp.delete('tab');
      else sp.set('tab', next);
      const qs = sp.toString();
      window.history.replaceState(window.history.state, '', `${pathname}${qs ? `?${qs}` : ''}`);
    },
    [pathname, fallback],
  );

  return [tab, setTab];
}
