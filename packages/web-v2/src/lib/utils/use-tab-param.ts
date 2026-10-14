'use client';

import { useCallback } from 'react';
import { usePathname } from 'next/navigation';
import { replaceLocationSearch, useLocationSearch } from './use-location-search';

/** `aliases` maps a tab value a screen no longer has to the tab that now holds its content, so an
 *  old link lands where that content went rather than on the default tab. */
export function useTabParam<T extends string>(
  valid: readonly T[],
  fallback: T,
  aliases: Readonly<Record<string, T>> = {},
): [T, (t: T) => void] {
  const pathname = usePathname() || '';
  const search = useLocationSearch();

  const raw = new URLSearchParams(search).get('tab');
  const tab =
    raw && (valid as readonly string[]).includes(raw)
      ? (raw as T)
      : raw && Object.hasOwn(aliases, raw)
        ? (aliases[raw] as T)
        : fallback;

  const setTab = useCallback(
    (next: T) => {
      if (typeof window === 'undefined') return;
      const sp = new URLSearchParams(window.location.search);
      if (next === fallback) sp.delete('tab');
      else sp.set('tab', next);
      const qs = sp.toString();
      replaceLocationSearch(`${pathname}${qs ? `?${qs}` : ''}`);
    },
    [pathname, fallback],
  );

  return [tab, setTab];
}
