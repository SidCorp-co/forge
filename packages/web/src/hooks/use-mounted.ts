'use client';

import { useEffect, useState } from 'react';

/**
 * Returns true after the first client paint. Use to gate rendering that
 * depends on browser-only state (theme, localStorage, window) so SSR markup
 * matches the first hydration pass and React doesn't unmount/remount the
 * subtree (avoids React error #418 — see ISS-309).
 */
export function useMounted(): boolean {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return mounted;
}
