'use client';

import { useTheme } from 'next-themes';
import { useCallback } from 'react';

// Server-side persistence via `/api/user-preferences` was a Strapi-flavoured
// call that forge/core does not implement. `next-themes` already persists the
// user's choice in localStorage, which is sufficient for v0.1. See ISS-243.
export function useThemePreference() {
  const { theme, setTheme, resolvedTheme } = useTheme();

  const saveTheme = useCallback(
    (newTheme: 'light' | 'dark' | 'system') => {
      setTheme(newTheme);
    },
    [setTheme]
  );

  return { theme, resolvedTheme, saveTheme };
}
