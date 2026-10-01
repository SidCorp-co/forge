'use client';

import { useCallback } from 'react';
import { usePathname } from 'next/navigation';
import { useLocationSearch } from './use-location-search';

export function useQueryParam(name: string): [string | null, (next: string | null) => void] {
  const pathname = usePathname() || '';
  const search = useLocationSearch();
  const value = new URLSearchParams(search).get(name);
  const set = useCallback(
    (next: string | null) => {
      if (typeof window === 'undefined') return;
      const sp = new URLSearchParams(window.location.search);
      if (next === null) sp.delete(name);
      else sp.set(name, next);
      const qs = sp.toString();
      window.history.replaceState(window.history.state, '', `${pathname}${qs ? `?${qs}` : ''}`);
    },
    [pathname, name],
  );
  return [value, set];
}
