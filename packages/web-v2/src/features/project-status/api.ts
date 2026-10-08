import type { ProjectStatus } from "@forge/contracts/project-status";
import type { StatusReportDetail, StatusReportMeta } from "@forge/contracts/status-reports";
import { apiClient } from "@/lib/api/client";

const base = (projectId: string) => `/projects/${encodeURIComponent(projectId)}/status`;

export const projectStatusApi = {
  read: (projectId: string, days: number) => apiClient<ProjectStatus>(`${base(projectId)}?days=${days}`),
  reports: (projectId: string) => apiClient<{ reports: StatusReportMeta[] }>(`${base(projectId)}/reports`),
  report: (projectId: string, reportId: string) => apiClient<StatusReportDetail>(`${base(projectId)}/reports/${encodeURIComponent(reportId)}`),
  markRead: (projectId: string, reportId: string) =>
    apiClient<{ read: number }>(`${base(projectId)}/reports/${encodeURIComponent(reportId)}/read`, { method: "POST" }),
  remove: (projectId: string, reportId: string) =>
    apiClient<{ deleted: string }>(`${base(projectId)}/reports/${encodeURIComponent(reportId)}`, { method: "DELETE" }),
  save: (projectId: string, days: number) =>
    apiClient<StatusReportMeta>(`${base(projectId)}/reports`, { method: "POST", body: JSON.stringify({ days }) }),
};
