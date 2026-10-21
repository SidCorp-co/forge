import { apiClient, apiClientList } from "@/lib/api/client";
import { BOARD_EXCLUDED_STATUSES } from "./types";
import type {
  AnalyticsOpts,
  PipelineIssueRow,
  PipelineRunListItem,
  PipelineRunSummary,
  ProjectRunsOpts,
  StepDurationRow,
  ThroughputRow,
} from "./types";

/** Issues fetched for the kanban (one page is enough for a board view). */
const PIPELINE_ISSUES_PAGE_SIZE = 200;

function analyticsParams(opts: AnalyticsOpts): string {
  const params = new URLSearchParams();
  if (opts.days != null) params.set("days", String(opts.days));
  if (opts.projectId) params.set("projectId", opts.projectId);
  if (opts.step) params.set("step", opts.step);
  return params.toString();
}

export const pipelineApi = {
  runsForProject: (opts: ProjectRunsOpts) => {
    const params = new URLSearchParams({
      limit: String(opts.limit ?? 100),
      offset: String(opts.offset ?? 0),
    });
    if (opts.status) params.set("status", opts.status);
    if (opts.issueId) params.set("issueId", opts.issueId);
    return apiClientList<PipelineRunListItem>(
      `/projects/${opts.projectId}/pipeline-runs?${params}`,
    );
  },

  /** `GET /api/pipeline-runs/:id` — full run rollup (steps + cost). */
  run: (id: string) => apiClient<PipelineRunSummary>(`/pipeline-runs/${id}`),

  stepDurations: (opts: AnalyticsOpts = {}) =>
    apiClient<StepDurationRow[]>(`/pipeline/step-durations?${analyticsParams(opts)}`),

  /** `GET /api/pipeline/throughput?days&projectId` — daily closed/released. */
  throughput: (opts: Omit<AnalyticsOpts, "step"> = {}) =>
    apiClient<ThroughputRow[]>(`/pipeline/throughput?${analyticsParams(opts)}`),

  issuesForProject: (projectId: string) => {
    const params = new URLSearchParams({
      limit: String(PIPELINE_ISSUES_PAGE_SIZE),
      offset: "0",
      withAgentSessions: "true",
      withPipelineHealth: "1",
      sort: "updatedAt:desc",
    });
    for (const s of BOARD_EXCLUDED_STATUSES) params.append("statusNot", s);
    return apiClientList<PipelineIssueRow>(`/projects/${projectId}/issues/search?${params}`);
  },
};
