import { apiClient } from "@/lib/api/client";
import type { ScheduleRow } from "./types";

export const schedulesApi = {
  list: (projectId: string) =>
    apiClient<ScheduleRow[]>(`/schedules?projectId=${encodeURIComponent(projectId)}`),

  setEnabled: (id: string, enabled: boolean) =>
    apiClient<ScheduleRow>(`/schedules/${id}`, {
      method: "PUT",
      body: JSON.stringify({ enabled }),
    }),

  run: (id: string) =>
    apiClient<{ fireId: string; sessionId: string | null; message: string }>(`/schedules/${id}/run`, { method: "POST" }),


};
