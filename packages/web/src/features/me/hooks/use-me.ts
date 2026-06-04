'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { meApi } from '../api';
import type { MePreferences } from '../types';

const PROFILE_KEY = ['me', 'profile'] as const;
const PREFS_KEY = ['me', 'preferences'] as const;

export function useMeProfile() {
  return useQuery({
    queryKey: PROFILE_KEY,
    queryFn: () => meApi.getProfile(),
    staleTime: 60_000,
  });
}

export function useMePreferences() {
  return useQuery({
    queryKey: PREFS_KEY,
    queryFn: () => meApi.getPreferences(),
    staleTime: 60_000,
  });
}

export function useUpdateMePreferences() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: Partial<Pick<MePreferences, 'theme' | 'language' | 'lastSeenWhatsNew'>>) =>
      meApi.updatePreferences(patch),
    onSuccess: (data) => {
      qc.setQueryData(PREFS_KEY, data);
    },
  });
}
