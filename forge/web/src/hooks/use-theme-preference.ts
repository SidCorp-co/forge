'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTheme } from 'next-themes';
import { useEffect } from 'react';
import { ApiError, apiClient } from '@/lib/api/client';
import { useAuth } from '@/providers/auth-provider';

export type PreferenceTheme = 'system' | 'light' | 'dark';
export type PreferenceLanguage = 'en' | 'vi';

export interface UserPreferences {
  userId: string;
  theme: PreferenceTheme;
  language: PreferenceLanguage;
  updatedAt: string | null;
}

const PREFS_KEY = ['user-prefs'] as const;

/**
 * Fetch + persist the user's theme/language preference on `forge/core`.
 * Falls back to `next-themes` localStorage when the request hasn't returned
 * yet so the toggle stays responsive.
 *
 * The WS listener for `user.preferencesChanged` (see `lib/ws/event-router`)
 * invalidates `['user-prefs']` so other tabs sync when one mutates.
 */
export function useThemePreference() {
  const qc = useQueryClient();
  const { user, isLoading: authLoading } = useAuth();
  const { theme, setTheme, resolvedTheme } = useTheme();

  const { data } = useQuery<UserPreferences>({
    queryKey: PREFS_KEY,
    queryFn: async () => {
      try {
        return await apiClient<UserPreferences>('/auth/preferences');
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          // Not authenticated yet — caller will retry once auth resolves.
          throw err;
        }
        throw err;
      }
    },
    enabled: !authLoading && !!user,
    staleTime: 60_000,
  });

  // Mirror the server-side theme into next-themes once on first load so
  // the UI matches what other tabs / devices have set.
  useEffect(() => {
    if (!data) return;
    if (data.theme && data.theme !== theme) setTheme(data.theme);
  }, [data, setTheme, theme]);

  const mutation = useMutation({
    mutationFn: async (input: { theme?: PreferenceTheme; language?: PreferenceLanguage }) =>
      apiClient<UserPreferences>('/auth/preferences', {
        method: 'PATCH',
        body: JSON.stringify(input),
      }),
    onSuccess: (next) => {
      qc.setQueryData<UserPreferences>(PREFS_KEY, next);
    },
  });

  const saveTheme = (newTheme: PreferenceTheme) => {
    setTheme(newTheme);
    if (user) mutation.mutate({ theme: newTheme });
  };

  return {
    theme,
    resolvedTheme,
    language: data?.language ?? 'en',
    saveTheme,
  };
}
