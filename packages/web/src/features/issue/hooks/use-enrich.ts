'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { issueApi } from '../api/issue-api';
import { issueKeys } from './use-issues';

export function useEnrichIssue() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => issueApi.enrich(id),
    onSuccess: (_data, id) => {
      qc.invalidateQueries({ queryKey: issueKeys.detail(id) });
      qc.invalidateQueries({ queryKey: ['agent-sessions'] });
    },
  });
}
