import { apiClient, apiClientList } from "@/lib/api/client";
import { BOARD_EXCLUDED_STATUSES } from "./types";
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

/**
 * Refuses a page whose rows do not say whether a box is on them (ISS-1213): read as absent, every
 * such row would sit under Stalled, which is a guess. A core older than this web build is the cause.
 */
export function requireHeld<P extends { items: PipelineIssueRow[] }>(page: P): P {
  const missing = page.items.filter((i) => typeof i.held !== "boolean").map((i) => i.displayId);
  if (missing.length > 0) {
    throw new Error(
      `The issue search did not say whether anything is working ${missing.slice(0, 3).join(", ")}${missing.length > 3 ? ` and ${missing.length - 3} more` : ""}, so the board cannot tell Running from Stalled. The server is older than this page; it needs the release that serves \`held\` (ISS-1213).`,
    );
  }
  return page;
}

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

  stepDurations: (opts: AnalyticsOpts = {}) =>
    apiClient<StepDurationRow[]>(`/pipeline/step-durations?${analyticsParams(opts)}`),

  /** `GET /api/pipeline/throughput?days&projectId` — daily closed/released. */
  throughput: (opts: AnalyticsOpts = {}) =>
    apiClient<ThroughputRow[]>(`/pipeline/throughput?${analyticsParams(opts)}`),

  /** `GET /api/issues/:id/tasks` — subtasks for the RunDetail Tasks tab. */
  tasksForIssue: (issueId: string) => apiClient<TaskRow[]>(`/issues/${issueId}/tasks`),

  issuesForProject: (projectId: string) => {
    const params = new URLSearchParams({
      limit: String(PIPELINE_ISSUES_PAGE_SIZE),
      offset: "0",
      withAgentSessions: "true",
      withPipelineHealth: "1",
      sort: "updatedAt:desc",
    });
    for (const s of BOARD_EXCLUDED_STATUSES) params.append("statusNot", s);
    return apiClientList<PipelineIssueRow>(`/projects/${projectId}/issues/search?${params}`).then(
      requireHeld,
    );
  },
};
