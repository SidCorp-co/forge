'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { appConfigApi } from '../api';
import type { AppConfigPatch } from '../types';

export const appConfigKeys = {
  detail: (projectId: string | undefined) => ['app-config', projectId] as const,
};

export function useAppConfig(projectId: string | undefined) {
  return useQuery({
    queryKey: appConfigKeys.detail(projectId),
    queryFn: () => appConfigApi.get(projectId as string),
    enabled: !!projectId,
  });
}

export function useUpsertAppConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ projectId, patch }: { projectId: string; patch: AppConfigPatch }) =>
      appConfigApi.upsert(projectId, patch),
    onSuccess: (_data, { projectId }) => {
      qc.invalidateQueries({ queryKey: appConfigKeys.detail(projectId) });
    },
  });
}
