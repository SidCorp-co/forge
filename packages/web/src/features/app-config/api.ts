import { apiClient } from '@/lib/api/client';
import type { AppConfig, AppConfigPatch } from './types';

export const appConfigApi = {
  get: (projectId: string) => apiClient<AppConfig | null>(`/app-config/${projectId}`),

  upsert: (projectId: string, patch: AppConfigPatch) =>
    apiClient<AppConfig>(`/app-config/${projectId}`, {
      method: 'PUT',
      body: JSON.stringify(patch),
    }),
};
