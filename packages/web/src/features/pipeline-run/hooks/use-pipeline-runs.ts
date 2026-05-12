'use client';

import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { pipelineRunApi, type PipelineRunListParams } from '../api/pipeline-run-api';

/**
 * Stable query keys. Keep in sync with `src/lib/ws/event-router.ts` —
 * the `pipeline_run.status_changed` case invalidates these on the fly.
 */
export const pipelineRunKeys = {
  all: ['pipeline-runs'] as const,
  lists: ['pipeline-runs', 'list'] as const,
  list: (params: PipelineRunListParams) => ['pipeline-runs', 'list', params] as const,
  detail: (id: string | undefined) => ['pipeline-run', id] as const,
};

export function useProjectPipelineRuns(params: PipelineRunListParams) {
  return useQuery({
    queryKey: pipelineRunKeys.list(params),
    queryFn: () => pipelineRunApi.list(params),
    enabled: !!params.projectId,
    placeholderData: keepPreviousData,
  });
}

export function usePipelineRun(id: string | undefined) {
  return useQuery({
    queryKey: pipelineRunKeys.detail(id),
    queryFn: () => pipelineRunApi.get(id as string),
    enabled: !!id,
  });
}

export function usePausePipelineRun() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => pipelineRunApi.pause(id),
    onSuccess: (_data, id) => {
      qc.invalidateQueries({ queryKey: pipelineRunKeys.detail(id) });
      qc.invalidateQueries({ queryKey: pipelineRunKeys.lists });
    },
  });
}

export function useResumePipelineRun() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => pipelineRunApi.resume(id),
    onSuccess: (_data, id) => {
      qc.invalidateQueries({ queryKey: pipelineRunKeys.detail(id) });
      qc.invalidateQueries({ queryKey: pipelineRunKeys.lists });
    },
  });
}

export function useCancelPipelineRun() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => pipelineRunApi.cancel(id),
    onSuccess: (_data, id) => {
      qc.invalidateQueries({ queryKey: pipelineRunKeys.detail(id) });
      qc.invalidateQueries({ queryKey: pipelineRunKeys.lists });
      // Cancel cascades to jobs + agent-sessions.
      qc.invalidateQueries({ queryKey: ['jobs'] });
      qc.invalidateQueries({ queryKey: ['agent-sessions'] });
    },
  });
}
