'use client';

import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import {
  type JobCreateInput,
  type JobListParams,
  jobApi,
} from '../api/job-api';

/**
 * Stable React Query keys — F3's WS event router invalidates these on
 * `job.assigned` / `job.statusChanged` / `job.event`. Do not rename without
 * syncing `src/lib/ws/event-router.ts`.
 */
export const jobKeys = {
  all: ['jobs'] as const,
  lists: ['jobs', 'list'] as const,
  list: (params: JobListParams) => ['jobs', 'list', params] as const,
  detail: (id: string | undefined) => ['job', id] as const,
  events: (id: string | undefined) => ['job', id, 'events'] as const,
};

export function useJobs(params: JobListParams) {
  return useQuery({
    queryKey: jobKeys.list(params),
    queryFn: () => jobApi.list(params),
    enabled: !!params.projectId,
    placeholderData: keepPreviousData,
  });
}

export function useJob(id: string | undefined) {
  return useQuery({
    queryKey: jobKeys.detail(id),
    queryFn: () => jobApi.get(id as string),
    enabled: !!id,
  });
}

export function useJobEvents(id: string | undefined) {
  return useQuery({
    queryKey: jobKeys.events(id),
    queryFn: () => jobApi.events({ jobId: id as string }),
    enabled: !!id,
    // Event listing endpoint lands in F3; until then this query will 404.
    // The UI shows an empty-state while isError=true.
    retry: false,
  });
}

export function useCreateJob(projectId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: JobCreateInput) => {
      if (!projectId) throw new Error('projectId is required to create a job');
      return jobApi.create(projectId, input);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: jobKeys.lists });
    },
  });
}

export function useCancelJob() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => jobApi.cancel(id),
    onSuccess: (_data, id) => {
      qc.invalidateQueries({ queryKey: jobKeys.lists });
      qc.invalidateQueries({ queryKey: jobKeys.detail(id) });
    },
  });
}
