import { apiClient, } from "@/lib/api/client";
import type {
  AutomationStandingResponse,
  FireDetailResponse,
  ReportDetailResponse,
  ScheduleDetailResponse,
} from "./types";

const projectPath = (projectId: string) => `/projects/${encodeURIComponent(projectId)}/automation`;

export const automationApi = {
  /** `GET /api/projects/:id/automation/standing` — schedules, fires, reports and proposals. */
  standing: (projectId: string) => apiClient<AutomationStandingResponse>(`${projectPath(projectId)}/standing`),

  /** `GET /api/projects/:id/automation/schedules/:scheduleId?firesLimit=` — one schedule and its fires. */
  schedule: (projectId: string, scheduleId: string, firesLimit = 20) =>
    apiClient<ScheduleDetailResponse>(
      `${projectPath(projectId)}/schedules/${encodeURIComponent(scheduleId)}?firesLimit=${firesLimit}`,
    ),

  fire: (projectId: string, fireId: string) =>
    apiClient<FireDetailResponse>(`${projectPath(projectId)}/fires/${encodeURIComponent(fireId)}`),

  report: (projectId: string, reportId: string) =>
    apiClient<ReportDetailResponse>(`${projectPath(projectId)}/reports/${encodeURIComponent(reportId)}`),
};
