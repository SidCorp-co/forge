'use client';

import { useQuery } from '@tanstack/react-query';
import { dashboardApi } from '../api';
import type { AttentionResponse } from '../types';

const EMPTY: AttentionResponse = {
  needsReview: [],
  awaitingInput: [],
  mentions: [],
  failedJobs: [],
  total: 0,
};

export function useAttentionQueue() {
  return useQuery({
    queryKey: ['me', 'attention'],
    queryFn: () => dashboardApi.getAttention(),
    refetchInterval: 30 * 1000,
    staleTime: 15 * 1000,
    select: (res) => res ?? EMPTY,
  });
}
