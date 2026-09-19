import { apiClient } from "@/lib/api/client";
import type { ScheduleRow, ScheduleRun } from "./types";

export const schedulesApi = {
  list: (projectId: string) =>
    apiClient<ScheduleRow[]>(`/schedules?projectId=${encodeURIComponent(projectId)}`),

  setEnabled: (id: string, enabled: boolean) =>
    apiClient<ScheduleRow>(`/schedules/${id}`, {
      method: "PUT",
      body: JSON.stringify({ enabled }),
    }),

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
