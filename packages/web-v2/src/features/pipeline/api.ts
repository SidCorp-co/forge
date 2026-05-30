// web-v2 feature module: pipeline — REST surface. All calls go through the
// shared `apiClient`/`apiClientList` (no raw fetch). Routes verified against
// core for ISS-295:
//   - `packages/core/src/pipeline/runs-read-routes.ts`  (list + detail)
//   - `packages/core/src/pipeline/runs-routes.ts`       (pause/resume/cancel)
//   - `packages/core/src/pipeline/analytics-routes.ts`  (throughput/durations)
//   - `packages/core/src/issues/search` route           (kanban cards)
import { apiClient, apiClientList } from "@/lib/api/client";
import type {
  AnalyticsOpts,
  PipelineIssueRow,
  PipelineRunListItem,
  PipelineRunSummary,
  ProjectRunsOpts,
  StepDurationRow,
  TaskRow,
  ThroughputRow,
} from "./types";

/** Issues fetched for the kanban (one page is enough for a board view). */
export const PIPELINE_ISSUES_PAGE_SIZE = 200;

function analyticsParams(opts: AnalyticsOpts): string {
  const params = new URLSearchParams();
  if (opts.days != null) params.set("days", String(opts.days));
  if (opts.projectId) params.set("projectId", opts.projectId);
  if (opts.step) params.set("step", opts.step);
  return params.toString();
}

export const pipelineApi = {
  /**
   * `GET /api/projects/:id/pipeline-runs?limit&offset&status&issueId` — the
   * per-project run list (ordered by `startedAt` desc). Returns `{ items,
   * totalCount }` (totalCount from `X-Total-Count`).
   */
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

  /** `POST /api/pipeline-runs/:id/pause`. */
  pause: (id: string) => apiClient<unknown>(`/pipeline-runs/${id}/pause`, { method: "POST" }),

  /** `POST /api/pipeline-runs/:id/resume`. */
  resume: (id: string) => apiClient<unknown>(`/pipeline-runs/${id}/resume`, { method: "POST" }),

  /** `POST /api/pipeline-runs/:id/cancel`. */
  cancel: (id: string) => apiClient<unknown>(`/pipeline-runs/${id}/cancel`, { method: "POST" }),

  /** `GET /api/pipeline/step-durations?days&projectId&step` — cross-project
   *  per-step durations + cost from the `pipeline_run_step_durations` view. */
  stepDurations: (opts: AnalyticsOpts = {}) =>
    apiClient<StepDurationRow[]>(`/pipeline/step-durations?${analyticsParams(opts)}`),

  /** `GET /api/pipeline/throughput?days&projectId` — daily closed/released. */
  throughput: (opts: AnalyticsOpts = {}) =>
    apiClient<ThroughputRow[]>(`/pipeline/throughput?${analyticsParams(opts)}`),

  /** `GET /api/issues/:id/tasks` — subtasks for the RunDetail Tasks tab. */
  tasksForIssue: (issueId: string) => apiClient<TaskRow[]>(`/issues/${issueId}/tasks`),

  /** `GET /api/projects/:id/issues/search` — issues for the kanban cards,
   *  hydrated with `agentStatus`. One page (board view, not paginated). */
  issuesForProject: (projectId: string) => {
    const params = new URLSearchParams({
      limit: String(PIPELINE_ISSUES_PAGE_SIZE),
      offset: "0",
      withAgentSessions: "true",
      sort: "updatedAt:desc",
    });
    // Hide drafts + closed from the board (matches the issues table default).
    for (const s of ["draft", "closed"]) params.append("statusNot", s);
    return apiClientList<PipelineIssueRow>(`/projects/${projectId}/issues/search?${params}`);
  },
};
