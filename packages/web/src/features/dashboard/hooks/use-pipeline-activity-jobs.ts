'use client';

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { Job } from '@forge/contracts';
import { agentApi } from '@/features/agent/api';
import { useJobs } from '@/features/job/hooks/use-jobs';
import { useProjectPipelineRuns } from '@/features/pipeline-run/hooks/use-pipeline-runs';
import type { PipelineRunKind } from '@/features/pipeline-run/types';

/**
 * Current dispatcher concurrency. The dispatch gates in
 * `packages/core/src/jobs/dispatch-gates.ts` cap a runner at one in-flight job
 * (RUNNER_CAP=1). queue-stats exposes no cap field, so this mirrors that
 * constant until a project-scoped runner-load read surfaces the real cap.
 */
export const RUNNER_CAP = 1;

/** Matches the 5-minute stale-sweep threshold (`runStaleSweep`). */
const STUCK_THRESHOLD_MS = 5 * 60_000;

export interface RunnerCapacity {
  deviceId: string | null;
  running: number;
  queued: number;
  full: boolean;
}

export interface PipelineActivityJobs {
  running: Job[];
  queued: Job[];
  runKindById: Map<string, PipelineRunKind>;
  capacity: RunnerCapacity[];
  stuckIds: Set<string>;
  isLoading: boolean;
  error: unknown;
}

// Drizzle's $inferSelect types timestamp columns as Date, but the JSON wire
// payload delivers ISO strings; new Date(...) accepts either.
function elapsedSince(value: Date | string | null): number {
  if (!value) return 0;
  return Date.now() - new Date(value).getTime();
}

export function usePipelineActivityJobs(
  projectId: string | undefined,
): PipelineActivityJobs {
  // Three per-status queries keep the WS invalidation of ['jobs','list']
  // working for each status independently.
  const queuedQuery = useJobs({ projectId: projectId ?? '', status: 'queued', limit: 50 });
  const dispatchedQuery = useJobs({ projectId: projectId ?? '', status: 'dispatched', limit: 50 });
  const runningQuery = useJobs({ projectId: projectId ?? '', status: 'running', limit: 50 });

  const runsQuery = useProjectPipelineRuns({ projectId: projectId ?? '', limit: 50 });

  // queue-stats has no WS invalidation key, so poll it like usePipelineActivity.
  const statsQuery = useQuery({
    queryKey: ['queue-stats', projectId],
    queryFn: () => agentApi.queueStats(projectId!),
    enabled: !!projectId,
    refetchInterval: 10_000,
    staleTime: 5_000,
  });

  const queuedItems = queuedQuery.data?.items;
  const dispatchedItems = dispatchedQuery.data?.items;
  const runningItems = runningQuery.data?.items;
  const runItems = runsQuery.data?.items;
  const devices = statsQuery.data?.devices;

  return useMemo<PipelineActivityJobs>(() => {
    const dispatched = dispatchedItems ?? [];
    const runningRows = runningItems ?? [];

    // Running = dispatched ∪ running, oldest-first by dispatchedAt (fall back
    // to queuedAt when a row has not recorded a dispatch timestamp).
    const running = [...dispatched, ...runningRows].sort(
      (a, b) =>
        new Date(a.dispatchedAt ?? a.queuedAt).getTime() -
        new Date(b.dispatchedAt ?? b.queuedAt).getTime(),
    );

    // Waiting = queued, oldest queuedAt first (core returns desc; re-sort asc).
    const queued = [...(queuedItems ?? [])].sort(
      (a, b) => new Date(a.queuedAt).getTime() - new Date(b.queuedAt).getTime(),
    );

    const runKindById = new Map<string, PipelineRunKind>();
    for (const r of runItems ?? []) runKindById.set(r.id, r.kind);

    const stuckIds = new Set<string>();
    for (const job of dispatched) {
      if (job.dispatchedAt && elapsedSince(job.dispatchedAt) > STUCK_THRESHOLD_MS) {
        stuckIds.add(job.id);
      }
    }

    const capacity: RunnerCapacity[] = (devices ?? []).map((d) => ({
      deviceId: d.deviceId,
      running: d.running,
      queued: d.queued,
      full: d.running >= RUNNER_CAP,
    }));

    return {
      running,
      queued,
      runKindById,
      capacity,
      stuckIds,
      isLoading:
        queuedQuery.isLoading || dispatchedQuery.isLoading || runningQuery.isLoading,
      error: queuedQuery.error ?? dispatchedQuery.error ?? runningQuery.error,
    };
  }, [
    queuedItems,
    dispatchedItems,
    runningItems,
    runItems,
    devices,
    queuedQuery.isLoading,
    dispatchedQuery.isLoading,
    runningQuery.isLoading,
    queuedQuery.error,
    dispatchedQuery.error,
    runningQuery.error,
  ]);
}
