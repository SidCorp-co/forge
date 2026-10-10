"use client";

import { useQuery } from "@tanstack/react-query";
import { pipelineQueries } from "./queries";
import type { AnalyticsOpts } from "./types";

/** Per-project run list; the router invalidates the `['pipeline-runs','list']` prefix. */
export function useProjectRuns(projectId: string | undefined) {
  return useQuery(pipelineQueries.projectRuns(projectId));
}

export function useProjectIssues(projectId: string | undefined) {
  return useQuery(pipelineQueries.projectIssues(projectId));
}

/** Single run rollup, WS-live. Only fetched when `enabled` (i.e. the SlideOver is open). */
export function useRun(runId: string | undefined, enabled = true) {
  return useQuery(pipelineQueries.run(runId, enabled));
}

/** Cross-project per-step durations + cost. */
export function useStepDurations(opts: AnalyticsOpts = {}) {
  return useQuery(pipelineQueries.stepDurations(opts));
}

/** Cross-project daily throughput. */
export function useThroughput(opts: AnalyticsOpts = {}) {
  return useQuery(pipelineQueries.throughput(opts));
}
