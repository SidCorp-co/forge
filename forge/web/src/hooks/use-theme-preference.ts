'use client';

import { useTheme } from 'next-themes';
import { useCallback, useEffect, useRef } from 'react';
import { apiClient } from '@/lib/api/client';
import { useAuth } from '@/providers/auth-provider';

interface UserPreference {
  documentId: string;
  userKey: string;
  theme: 'light' | 'dark' | 'system' | null;
}

interface StrapiListResponse {
  data: UserPreference[];
}

export function useThemePreference() {
  const { theme, setTheme, resolvedTheme } = useTheme();
  const { user } = useAuth();
  const prefDocId = useRef<string | null>(null);
  const hasFetched = useRef(false);

  useEffect(() => {
    if (!user || hasFetched.current) return;
    hasFetched.current = true;

    apiClient<StrapiListResponse>(
      `/user-preferences?filters[userKey][$eq]=user:${user.id}`
    )
      .then((res) => {
        const pref = res.data?.[0];
        if (pref) {
          prefDocId.current = pref.documentId;
          // Only apply server preference if localStorage doesn't have one yet
          // (localStorage is set by next-themes on first toggle — it takes priority)
          const localTheme = localStorage.getItem('theme');
          if (!localTheme && pref.theme) setTheme(pref.theme);
        }
      })
      .catch(() => {});
  }, [user, setTheme]);

  const saveTheme = useCallback(
    async (newTheme: 'light' | 'dark' | 'system') => {
      setTheme(newTheme);
      if (!user) return;

      try {
        if (prefDocId.current) {
          await apiClient(`/user-preferences/${prefDocId.current}`, {
            method: 'PUT',
            body: JSON.stringify({ data: { theme: newTheme } }),
          });
        } else {
          const res = await apiClient<{ data: UserPreference }>(
            '/user-preferences',
            {
              method: 'POST',
              body: JSON.stringify({
                data: { userKey: `user:${user.id}`, theme: newTheme },
              }),
            }
          );
          prefDocId.current = res.data.documentId;
        }
      } catch {
        // Theme already applied locally via next-themes localStorage
      }
    },
    [user, setTheme]
  );

  return { theme, resolvedTheme, saveTheme };
}
