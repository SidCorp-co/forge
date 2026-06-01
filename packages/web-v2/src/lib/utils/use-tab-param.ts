'use client';

// Mirror an active tab into the `?tab=` query param without a navigation /
// refetch (shallow replaceState), hydrated from the URL once on mount so
// deep-links work without forcing a Suspense boundary. The first/default tab
// is represented as a bare URL (no `?tab=`). Shared by the merged screen shells
// (Agents · Library · Automation).
import { useEffect, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';

export function useTabParam<T extends string>(valid: readonly T[], fallback: T): [T, (t: T) => void] {
  const pathname = usePathname() || '';
  const [tab, setTab] = useState<T>(fallback);
  const hydrated = useRef(false);

  useEffect(() => {
    const sp = typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : null;
    const t = sp?.get('tab');
    if (t && (valid as readonly string[]).includes(t)) setTab(t as T);
    hydrated.current = true;
    // `valid` is a stable module-level const at every call site.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!hydrated.current || typeof window === 'undefined') return;
    // Mutate only the `tab` key — preserve every other query param (e.g. the
    // `?issue=` filter the Agents screen reads). Rebuilding the string from
    // scratch here previously wiped sibling params on mount (ISS-331 AC3).
    const sp = new URLSearchParams(window.location.search);
    if (tab === fallback) sp.delete('tab');
    else sp.set('tab', tab);
    const qs = sp.toString();
    window.history.replaceState(window.history.state, '', `${pathname}${qs ? `?${qs}` : ''}`);
  }, [pathname, tab, fallback]);

  return [tab, setTab];
}
