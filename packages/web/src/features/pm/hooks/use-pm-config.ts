'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { pmApi } from '../api/pm-api';
import type { PmConfigPatch } from '../types';

export const pmConfigKey = (projectId: string | undefined) =>
  ['pm', 'config', projectId] as const;

export function usePmConfig(projectId: string | undefined) {
  return useQuery({
    queryKey: pmConfigKey(projectId),
    queryFn: () => pmApi.getConfig(projectId as string),
    enabled: !!projectId,
  });
}

export function useUpdatePmConfig(projectId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: PmConfigPatch) =>
      pmApi.updateConfig(projectId as string, patch),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: pmConfigKey(projectId) });
    },
  });
}
