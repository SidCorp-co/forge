import { apiClient, apiClientList } from "@/lib/api/client";
import type {
  AnalyticsOpts,
  PipelineRunListItem,
  PipelineRunSummary,
  ProjectRunsOpts,
  StepDurationRow,
  ThroughputRow,
} from "./types";

function analyticsParams(opts: AnalyticsOpts): string {
  const params = new URLSearchParams();
  if (opts.days != null) params.set("days", String(opts.days));
  if (opts.projectId) params.set("projectId", opts.projectId);
  if (opts.step) params.set("step", opts.step);
  return params.toString();
}

export const runsApi = {
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
};
