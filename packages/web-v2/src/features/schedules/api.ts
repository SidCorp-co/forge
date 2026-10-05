import { apiClient } from "@/lib/api/client";
import type { ScheduleInput, ScheduleRow } from "./types";

export const schedulesApi = {
  list: (projectId: string) =>
    apiClient<ScheduleRow[]>(`/schedules?projectId=${encodeURIComponent(projectId)}`),

  create: (projectId: string, input: ScheduleInput) =>
    apiClient<ScheduleRow>(`/schedules`, {
      method: "POST",
      body: JSON.stringify({ projectId, ...input }),
    }),

  update: (id: string, patch: Partial<ScheduleInput>) =>
    apiClient<ScheduleRow>(`/schedules/${id}`, {
      method: "PUT",
      body: JSON.stringify(patch),
    }),

  remove: (id: string) => apiClient<void>(`/schedules/${id}`, { method: "DELETE" }),

  run: (id: string) =>
    apiClient<{ fireId: string; sessionId: string | null; message: string }>(`/schedules/${id}/run`, { method: "POST" }),
};
