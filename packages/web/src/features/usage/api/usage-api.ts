import { apiClient, apiClientList } from '@/lib/api/client';
import type { UsageSummary, UsageRecord } from '../types';

interface GetAllParams {
  projectId: string;
  source?: string;
  model?: string;
  from?: string;
  to?: string;
  page?: number;
  pageSize?: number;
}

export const usageApi = {
  getSummary: (projectId: string, days = 7) =>
    apiClient<UsageSummary>(
      `/usage-records/summary?projectId=${encodeURIComponent(projectId)}&days=${days}`,
    ).then((data) => ({ data })),

  getAll: async (params: GetAllParams) => {
    const query = new URLSearchParams(
      Object.entries(params)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => [k, String(v)]),
    );
    const { items, totalCount } = await apiClientList<UsageRecord>(
      `/usage-records?${query.toString()}`,
    );
    return { data: items, meta: { pagination: { total: totalCount } } };
  },

  ingestCli: (projectId: string, records: Array<Partial<UsageRecord> & { recordedAt: string; model: string; source: string }>) =>
    apiClient<{ ingested: number; scanned: number }>('/usage-records/ingest-cli', {
      method: 'POST',
      body: JSON.stringify({
        records: records.map((r) => ({ ...r, projectId })),
      }),
    }).then((data) => ({ data })),
};
