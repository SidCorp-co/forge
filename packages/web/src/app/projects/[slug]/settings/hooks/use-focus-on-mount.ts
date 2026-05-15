'use client';

import { useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

/**
 * Read `?focus=<key>` on mount, scroll the matching
 * `[data-config-health-target="<key>"]` element into view, then clear the
 * param so subsequent renders don't re-scroll.
 */
export function useFocusOnMount(): void {
  const router = useRouter();
  const params = useSearchParams();
  const focus = params?.get('focus') ?? null;

  useEffect(() => {
    if (!focus) return;
    const target = document.querySelector<HTMLElement>(
      `[data-config-health-target="${CSS.escape(focus)}"]`,
    );
    if (target) {
      target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    const next = new URLSearchParams(params?.toString() ?? '');
    next.delete('focus');
    const qs = next.toString();
    router.replace(qs ? `?${qs}` : '?', { scroll: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus]);
}
