import { apiClient } from "@/lib/api/client";

export const runControlApi = {
  /** `POST /api/pipeline-runs/:id/pause`. */
  pause: (id: string) => apiClient<unknown>(`/pipeline-runs/${id}/pause`, { method: "POST" }),

  /** `POST /api/pipeline-runs/:id/resume`. */
  resume: (id: string) => apiClient<unknown>(`/pipeline-runs/${id}/resume`, { method: "POST" }),

  /** `POST /api/pipeline-runs/:id/cancel`. */
  cancel: (id: string) =>
    apiClient<{ issueParked: boolean; parkRefused: { code: string; detail: string } | null }>(
      `/pipeline-runs/${id}/cancel`,
      { method: "POST" },
    ),
};
