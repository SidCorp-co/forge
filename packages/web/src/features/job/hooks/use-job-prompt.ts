'use client';

import { useQuery } from '@tanstack/react-query';
import { ApiError } from '@/lib/api/client';
import { promptApi } from '../api/prompt-api';
import { jobKeys } from './use-jobs';

export function useJobPrompt(jobId: string | undefined, options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: jobKeys.prompt(jobId),
    queryFn: () => promptApi.get(jobId as string),
    enabled: !!jobId && (options?.enabled ?? true),
    retry: (failureCount, err) => {
      // 404 (pre-v0.1.35 snapshot) and 410 (archived) are terminal answers; the
      // UI surfaces them as empty states, so retrying just delays the render.
      if (err instanceof ApiError && (err.status === 404 || err.status === 410)) return false;
      return failureCount < 2;
    },
  });
}
