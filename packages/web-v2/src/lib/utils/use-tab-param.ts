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
    const q = tab === fallback ? '' : `?tab=${tab}`;
    window.history.replaceState(window.history.state, '', `${pathname}${q}`);
  }, [pathname, tab, fallback]);

  return [tab, setTab];
}
