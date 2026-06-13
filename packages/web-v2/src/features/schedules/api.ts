// web-v2 feature module: schedules — REST surface. All calls go through the
// shared `apiClient`. Routes verified against `packages/core/src/schedules/routes.ts`.
import { apiClient } from "@/lib/api/client";
import type { ScheduleRow, ScheduleRun } from "./types";

export const schedulesApi = {
  /** `GET /api/schedules?projectId=` — flat rows (no X-Total-Count). */
  list: (projectId: string) =>
    apiClient<ScheduleRow[]>(`/schedules?projectId=${encodeURIComponent(projectId)}`),

  /** `PUT /api/schedules/:id` — partial update; used here for the enable toggle. */
  setEnabled: (id: string, enabled: boolean) =>
    apiClient<ScheduleRow>(`/schedules/${id}`, {
      method: "PUT",
      body: JSON.stringify({ enabled }),
    }),

  /** `POST /api/schedules/:id/run` — trigger a manual run now. */
  run: (id: string) =>
    apiClient<{ sessionId: string; message: string }>(`/schedules/${id}/run`, { method: "POST" }),

  /** `GET /api/schedules/:id/runs?limit=` — recent run history (newest first). */
  runs: (id: string, limit = 20) =>
    apiClient<{ runs: ScheduleRun[] }>(
      `/schedules/${id}/runs?limit=${encodeURIComponent(limit)}`,
    ),

  /** `DELETE /api/schedules/:id` — 204 No Content. */
  remove: (id: string) => apiClient<void>(`/schedules/${id}`, { method: "DELETE" }),
};
