'use client';

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
