import { useQuery } from '@tanstack/react-query';
import { fetchBlockContribution } from '../api';
import type { BlockContributionResponse } from '../types';

export function useBlockContribution(
  projectId: string | undefined,
  step: string,
  days = 30,
) {
  return useQuery<BlockContributionResponse>({
    queryKey: ['analytics', 'block-contribution', projectId, step, days],
    queryFn: () => fetchBlockContribution(projectId!, { step, days }),
    enabled: !!projectId && !!step,
    staleTime: 60_000,
  });
}
