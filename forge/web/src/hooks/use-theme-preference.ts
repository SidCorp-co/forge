'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTheme } from 'next-themes';
import { useEffect, useRef } from 'react';
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
    // The query result is meant to *seed* next-themes on the first paint
    // after login; subsequent local mutations are the source of truth. We
    // disable focus/reconnect refetches so a background refetch can't clobber
    // the user's in-flight click between optimistic onMutate and PATCH success.
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  // Hydrate next-themes from the server **once**, on the first time `data`
  // resolves after login. Subsequent server changes (other tab, etc.) are
  // intentionally ignored — cross-tab sync is handled by next-themes' own
  // localStorage listener.
  //
  // hydratedRef flips true on EITHER first server data arriving OR the user
  // clicking the toggle, whichever is first. This is the key to the ISS-310
  // race: if the GET response arrives *after* the click (e.g. on slow login
  // or first paint), the now-stale server value must NOT replace the user's
  // intentional choice. Tracking it as "hydrated" the moment the user picks
  // makes their click the source of truth from then on.
  const hydratedRef = useRef(false);
  useEffect(() => {
    if (hydratedRef.current) return;
    if (!data?.theme) return;
    hydratedRef.current = true;
    setTheme(data.theme);
  }, [data?.theme, setTheme]);

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
      // Synthesize a partial when prev is undefined (GET still in flight) so
      // a late-arriving GET response cannot clobber the optimistic value.
      qc.setQueryData<UserPreferences>(PREFS_KEY, (p) => {
        const base: UserPreferences = p ?? {
          userId: user?.id ?? '',
          theme: 'system',
          language: 'en',
          updatedAt: null,
        };
        return {
          ...base,
          ...(input.theme ? { theme: input.theme } : {}),
          ...(input.language ? { language: input.language } : {}),
        };
      });
      return { prev };
    },
    onError: (_err, _input, ctx) => {
      if (ctx && 'prev' in ctx && ctx.prev) qc.setQueryData(PREFS_KEY, ctx.prev);
    },
    onSuccess: (next) => {
      qc.setQueryData<UserPreferences>(PREFS_KEY, next);
    },
  });

  const saveTheme = (newTheme: PreferenceTheme) => {
    // Mark as hydrated immediately so a late-arriving GET response cannot
    // revert the click — see the comment on hydratedRef above.
    hydratedRef.current = true;
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
