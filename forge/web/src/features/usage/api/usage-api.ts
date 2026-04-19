import { apiClient } from '@/lib/api/client';
import type { UsageSummary, UsageRecord } from '../types';

interface GetAllParams {
  source?: string;
  model?: string;
  from?: string;
  to?: string;
  page?: number;
}

export const usageApi = {
  getSummary: (days = 7) =>
    apiClient<{ data: UsageSummary }>(`/usage-records/summary?days=${days}`),

  getAll: (params?: GetAllParams) => {
    const query = new URLSearchParams(
      Object.entries(params ?? {})
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => [k, String(v)])
    );
    const qs = query.toString();
    return apiClient<{ data: UsageRecord[]; meta: { pagination: { total: number } } }>(
      qs ? `/usage-records?${qs}` : '/usage-records'
    );
  },

  ingestCli: () =>
    apiClient<{ data: { ingested: number; scanned: number } }>('/usage-records/ingest-cli', {
      method: 'POST',
    }),
};
