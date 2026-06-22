// web-v2 feature module: improvement-messages — REST surface (ISS-549).
// Catalog: GET /api/improvement-messages
// Enable: POST /api/schedules (templateKey + mode + cron)
// Toggle/edit: PUT /api/schedules/:id
// Run now: POST /api/schedules/:id/run
// Run log: GET /api/schedules/:id/runs
import { apiClient } from "@/lib/api/client";
import type { ImprovementMessageEntry } from "./types";
import type { ScheduleRow, ScheduleRun } from "@/features/schedules/types";

export const improvementMessagesApi = {
  /** `GET /api/improvement-messages?projectId=` — catalog with per-project enablement. */
  list: (projectId: string) =>
    apiClient<ImprovementMessageEntry[]>(
      `/improvement-messages?projectId=${encodeURIComponent(projectId)}`,
    ),

  /** `POST /api/schedules` — enable a message by creating a schedule for this project. */
  enable: (payload: {
    projectId: string;
    templateKey: string;
    mode: "propose" | "auto";
    cron: string;
  }) =>
    apiClient<ScheduleRow>("/schedules", {
      method: "POST",
      body: JSON.stringify({
        projectId: payload.projectId,
        name: `improve:${payload.templateKey}`,
        cron: payload.cron,
        prompt: `[improvement-message:${payload.templateKey}]`,
        templateKey: payload.templateKey,
        mode: payload.mode,
      }),
    }),

  /** `PUT /api/schedules/:id` — toggle enabled state or update mode/cron. */
  update: (
    id: string,
    patch: { enabled?: boolean; mode?: "propose" | "auto"; cron?: string },
  ) =>
    apiClient<ScheduleRow>(`/schedules/${id}`, {
      method: "PUT",
      body: JSON.stringify(patch),
    }),

  /** `POST /api/schedules/:id/run` — trigger a manual run now. */
  run: (id: string) =>
    apiClient<{ sessionId: string; message: string }>(`/schedules/${id}/run`, {
      method: "POST",
    }),

  /** `GET /api/schedules/:id/runs?limit=` — recent run history (newest first). */
  runs: (id: string, limit = 20) =>
    apiClient<{ runs: ScheduleRun[] }>(
      `/schedules/${id}/runs?limit=${encodeURIComponent(limit)}`,
    ),
};
