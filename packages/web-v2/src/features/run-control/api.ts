import { apiClient } from "@/lib/api/client";

/** `POST /pipeline-runs/:id/cancel` answers 200 once the run is cancelled; a refused park of its issue
 *  rides the body, and the issue then keeps a status a master would take up again. */
export interface CancelRunResult {
  issueParked: boolean;
  parkRefused: { code: string; detail: string } | null;
}

export const runControlApi = {
  /** `POST /api/pipeline-runs/:id/pause`. */
  pause: (id: string) => apiClient<unknown>(`/pipeline-runs/${id}/pause`, { method: "POST" }),

  /** `POST /api/pipeline-runs/:id/resume`. */
  resume: (id: string) => apiClient<unknown>(`/pipeline-runs/${id}/resume`, { method: "POST" }),

  /** `POST /api/pipeline-runs/:id/cancel`. */
  cancel: (id: string) =>
    apiClient<CancelRunResult>(`/pipeline-runs/${id}/cancel`, { method: "POST" }),
};
