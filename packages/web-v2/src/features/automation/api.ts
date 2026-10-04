import { apiClient, apiClientList } from "@/lib/api/client";
import type {
  AutomationStandingResponse,
  PmConfig,
  PmConfigPatch,
  PmDecision,
  ScheduleDetailResponse,
} from "./types";

export const pmApi = {
  /** `GET /api/projects/:projectId/pm/config` — lazy-creates row if absent. */
  getConfig: (projectId: string) =>
    apiClient<PmConfig>(`/projects/${encodeURIComponent(projectId)}/pm/config`),

  /** `PUT /api/projects/:projectId/pm/config` — owner/admin only. */
  updateConfig: (projectId: string, patch: PmConfigPatch) =>
    apiClient<PmConfig>(`/projects/${encodeURIComponent(projectId)}/pm/config`, {
      method: "PUT",
      body: JSON.stringify(patch),
    }),

  run: (projectId: string) =>
    apiClient<unknown>(`/projects/${encodeURIComponent(projectId)}/pm/run`, { method: "POST" }),

  /** `GET /api/projects/:projectId/pm/decisions` — paginated, `X-Total-Count`. */
  listDecisions: (projectId: string, params: { page?: number; pageSize?: number } = {}) => {
    const qs = new URLSearchParams();
    if (params.page !== undefined) qs.set("page", String(params.page));
    if (params.pageSize !== undefined) qs.set("pageSize", String(params.pageSize));
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    return apiClientList<PmDecision>(
      `/projects/${encodeURIComponent(projectId)}/pm/decisions${suffix}`,
    );
  },
};

const projectPath = (projectId: string) => `/projects/${encodeURIComponent(projectId)}/automation`;

export const automationApi = {
  /** `GET /api/projects/:id/automation/standing` — schedules, fires, reports and proposals. */
  standing: (projectId: string) => apiClient<AutomationStandingResponse>(`${projectPath(projectId)}/standing`),

  /** `GET /api/projects/:id/automation/schedules/:scheduleId?firesLimit=` — one schedule and its fires. */
  schedule: (projectId: string, scheduleId: string, firesLimit = 20) =>
    apiClient<ScheduleDetailResponse>(
      `${projectPath(projectId)}/schedules/${encodeURIComponent(scheduleId)}?firesLimit=${firesLimit}`,
    ),
};
