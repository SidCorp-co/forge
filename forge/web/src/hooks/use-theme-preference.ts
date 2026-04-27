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

  // Mirror server-side theme into next-themes when an *incoming* server value
  // changes (other tab / device updated it). Crucially `theme` is NOT a dep:
  // local setTheme calls must not retrigger this effect, otherwise an in-flight
  // mutation's stale `data.theme` would revert the user's click before the
  // PATCH lands (the flicker fixed in ISS-309).
  useEffect(() => {
    if (!data?.theme) return;
    setTheme(data.theme);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data?.theme]);

  const mutation = useMutation({
    mutationFn: async (input: { theme?: PreferenceTheme; language?: PreferenceLanguage }) =>
      apiClient<UserPreferences>('/auth/preferences', {
        method: 'PATCH',
        body: JSON.stringify(input),
      }),
    onMutate: async (input) => {
      if (!input.theme && !input.language) return;
      await qc.cancelQueries({ queryKey: PREFS_KEY });
      const prev = qc.getQueryData<UserPreferences>(PREFS_KEY);
      qc.setQueryData<UserPreferences>(PREFS_KEY, (p) =>
        p ? { ...p, ...(input.theme ? { theme: input.theme } : {}), ...(input.language ? { language: input.language } : {}) } : p,
      );
      return { prev };
    },
    onError: (_err, _input, ctx) => {
      if (ctx?.prev) qc.setQueryData(PREFS_KEY, ctx.prev);
    },
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
