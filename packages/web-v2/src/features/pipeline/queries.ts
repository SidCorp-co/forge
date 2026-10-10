// The pipeline feature's reads: one key factory and its queryOptions. `pipeline-runs` and
// `pipeline-run` are the prefixes the WebSocket router invalidates (lib/ws/event-router.ts).
import { readOf } from "@/lib/api/query-kit";
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
  projectRuns: (projectId: string | undefined) => readOf(pipelineKeys.projectRuns(projectId), () => pipelineApi.runsForProject({ projectId: projectId as string }), 0),
  projectIssues: (projectId: string | undefined) => readOf(pipelineKeys.projectIssues(projectId), () => pipelineApi.issuesForProject(projectId as string), 0),
  run: (runId: string | undefined, enabled = true) => ({ ...readOf(pipelineKeys.run(runId), () => pipelineApi.run(runId as string), 0), enabled: enabled && !!runId }),
  stepDurations: (opts: AnalyticsOpts = {}) => readOf(pipelineKeys.stepDurations(opts), () => pipelineApi.stepDurations(opts), 30_000),
  throughput: (opts: AnalyticsOpts = {}) => readOf(pipelineKeys.throughput(opts), () => pipelineApi.throughput(opts), 30_000),
};
