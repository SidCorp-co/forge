'use client';

import { useTheme } from 'next-themes';
import { useEffect } from 'react';

/**
 * Forces the user's `data-theme` to "light" while a public marketing page
 * (landing, /download) is mounted, restoring their original preference on
 * unmount so internal app routes still honor system / dark / saved choice.
 *
 * Why: the SidCorp landing was designed light-only. Wrapping the page in a
 * `<div data-theme="light">` doesn't win against `<html data-theme="dark">`
 * because Tailwind v4's `@theme` block compiles utilities against the root
 * variables and `next-themes` writes that root attribute on `<html>`. The
 * cleanest reliable fix is to drive `next-themes` directly via its public
 * API, which keeps the SSR contract intact and avoids hydration warnings.
 *
 * Tradeoff: a brief flash of the user's saved theme before the effect runs.
 * Acceptable for a marketing page; eliminating it would require rewriting
 * the entire theme bootstrap script in the root layout, which is out of
 * scope for a public-page concern.
 */
export function ForceLightTheme() {
  const { setTheme, theme: currentTheme, resolvedTheme } = useTheme();

  useEffect(() => {
    const original = currentTheme ?? resolvedTheme ?? 'system';
    if (original !== 'light') {
      setTheme('light');
    }
    return () => {
      // Restore the visitor's preference so they don't get stuck in light
      // mode after browsing away from the marketing pages.
      if (original && original !== 'light') {
        setTheme(original);
      }
    };
    // We intentionally only run this on mount/unmount; the effect would
    // otherwise trigger every time `theme` changes (which it does as soon
    // as we call setTheme above) and bounce the visitor back.
    // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  }, []);

  return null;
}
