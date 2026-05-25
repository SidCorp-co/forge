'use client';

import { useQuery } from '@tanstack/react-query';
import { historyApi } from '../api/history-api';
import { jobKeys } from './use-jobs';

export function useJobHistory(
  issueId: string | null | undefined,
  step: string | null | undefined,
) {
  return useQuery({
    queryKey: jobKeys.history(issueId ?? undefined, step ?? undefined),
    queryFn: () => historyApi.list(issueId as string, step as string),
    enabled: !!issueId && !!step,
  });
}
