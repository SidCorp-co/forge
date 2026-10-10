// The pipeline feature's reads: one key factory and its queryOptions. `pipeline-runs` and
// `pipeline-run` are the prefixes the WebSocket router invalidates (lib/ws/event-router.ts).
import { queryOptions } from "@tanstack/react-query";
import { pipelineApi } from "./api";
import type { AnalyticsOpts } from "./types";

export const pipelineKeys = {
  runs: ["pipeline-runs"] as const,
  projectRuns: (projectId: string | undefined) => [...pipelineKeys.runs, "list", projectId] as const,
  run: (runId: string | undefined) => ["pipeline-run", runId] as const,
  analytics: ["pipeline"] as const,
  stepDurations: (opts: AnalyticsOpts) => [...pipelineKeys.analytics, "step-durations", opts] as const,
  throughput: (opts: AnalyticsOpts) => [...pipelineKeys.analytics, "throughput", opts] as const,
  /** The board's issue read sits under the issues family so issue writes refresh it. */
  projectIssues: (projectId: string | undefined) => ["issues", "search", projectId, "pipeline"] as const,
};

export const pipelineQueries = {
  projectRuns: (projectId: string | undefined) =>
    queryOptions({
      queryKey: pipelineKeys.projectRuns(projectId),
      queryFn: () => pipelineApi.runsForProject({ projectId: projectId as string }),
      enabled: !!projectId,
    }),
  projectIssues: (projectId: string | undefined) =>
    queryOptions({
      queryKey: pipelineKeys.projectIssues(projectId),
      queryFn: () => pipelineApi.issuesForProject(projectId as string),
      enabled: !!projectId,
    }),
  run: (runId: string | undefined, enabled = true) =>
    queryOptions({ queryKey: pipelineKeys.run(runId), queryFn: () => pipelineApi.run(runId as string), enabled: enabled && !!runId }),
  stepDurations: (opts: AnalyticsOpts = {}) =>
    queryOptions({ queryKey: pipelineKeys.stepDurations(opts), queryFn: () => pipelineApi.stepDurations(opts), staleTime: 30_000 }),
  throughput: (opts: AnalyticsOpts = {}) =>
    queryOptions({ queryKey: pipelineKeys.throughput(opts), queryFn: () => pipelineApi.throughput(opts), staleTime: 30_000 }),
};
