import { apiClient } from '@/lib/api/client';
import type { JobHistoryRow } from '../types';

export const historyApi = {
  list: (issueId: string, step: string) =>
    apiClient<JobHistoryRow[]>(
      `/issues/${issueId}/job-history?step=${encodeURIComponent(step)}`,
    ),
};
