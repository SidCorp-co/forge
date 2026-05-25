import { apiClient } from '@/lib/api/client';
import type { BlockContributionResponse } from './types';

export function fetchBlockContribution(
  projectId: string,
  opts: { step: string; days?: number },
): Promise<BlockContributionResponse> {
  const days = opts.days ?? 30;
  const qs = new URLSearchParams({ step: opts.step, days: String(days) });
  return apiClient<BlockContributionResponse>(
    `/projects/${encodeURIComponent(projectId)}/analytics/block-contribution?${qs.toString()}`,
  );
}
