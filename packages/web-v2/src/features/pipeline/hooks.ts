"use client";

import { useQuery } from "@tanstack/react-query";
import { pipelineApi } from "./api";
import type { AnalyticsOpts } from "./types";

/** Per-project run list. Keyed `['pipeline-runs','list',projectId]` — the
 *  router invalidates the `['pipeline-runs','list']` prefix. */
export function useProjectRuns(projectId: string | undefined) {
  return useQuery({
    queryKey: ["pipeline-runs", "list", projectId],
    queryFn: () => pipelineApi.runsForProject({ projectId: projectId as string }),
    enabled: !!projectId,
  });
}

export function useProjectIssues(projectId: string | undefined) {
  return useQuery({
    queryKey: ["issues", "search", projectId, "pipeline"],
    queryFn: () => pipelineApi.issuesForProject(projectId as string),
    enabled: !!projectId,
  });
}

/** Single run rollup. Keyed `['pipeline-run', runId]` — WS-live. Only fetched
 *  when `enabled` (i.e. the SlideOver is open). */
export function useRun(runId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: ["pipeline-run", runId],
    queryFn: () => pipelineApi.run(runId as string),
    enabled: enabled && !!runId,
  });
}

/** Cross-project per-step durations + cost. Keyed `['pipeline','step-durations',opts]`. */
export function useStepDurations(opts: AnalyticsOpts = {}) {
  return useQuery({
    queryKey: ["pipeline", "step-durations", opts],
    queryFn: () => pipelineApi.stepDurations(opts),
    staleTime: 30_000,
  });
}

/** Cross-project daily throughput. Keyed `['pipeline','throughput',opts]`. */
export function useThroughput(opts: AnalyticsOpts = {}) {
  return useQuery({
    queryKey: ["pipeline", "throughput", opts],
    queryFn: () => pipelineApi.throughput(opts),
    staleTime: 30_000,
  });
}

