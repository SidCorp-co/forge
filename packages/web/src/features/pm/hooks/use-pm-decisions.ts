'use client';

import { useQuery } from '@tanstack/react-query';
import { pmApi } from '../api/pm-api';

export const pmDecisionsKey = (
  projectId: string | undefined,
  page: number,
  pageSize: number,
  cause?: string,
) => ['pm', 'decisions', projectId, page, pageSize, cause ?? null] as const;

export function usePmDecisions(
  projectId: string | undefined,
  page = 1,
  pageSize = 25,
  cause?: string,
) {
  return useQuery({
    queryKey: pmDecisionsKey(projectId, page, pageSize, cause),
    queryFn: () =>
      pmApi.listDecisions(projectId as string, {
        page,
        pageSize,
        ...(cause ? { cause } : {}),
      }),
    enabled: !!projectId,
  });
}
