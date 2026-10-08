import type { ProjectStatus } from "@forge/contracts/project-status";
import type { StatusReportDetail, StatusReportMeta } from "@forge/contracts/status-reports";
import { apiClient, apiFile } from "@/lib/api/client";

const base = (projectId: string) => `/projects/${encodeURIComponent(projectId)}/status`;

export const projectStatusApi = {
  read: (projectId: string, days: number) => apiClient<ProjectStatus>(`${base(projectId)}?days=${days}`),
  reports: (projectId: string) => apiClient<{ reports: StatusReportMeta[] }>(`${base(projectId)}/reports`),
  report: (projectId: string, reportId: string) => apiClient<StatusReportDetail>(`${base(projectId)}/reports/${encodeURIComponent(reportId)}`),
  markRead: (projectId: string, reportId: string) =>
    apiClient<{ read: number }>(`${base(projectId)}/reports/${encodeURIComponent(reportId)}/read`, { method: "POST" }),
  remove: (projectId: string, reportId: string) =>
    apiClient<{ deleted: string }>(`${base(projectId)}/reports/${encodeURIComponent(reportId)}`, { method: "DELETE" }),
  /** A kept template report as core exports it: the whole report as Markdown, or one table block as CSV. */
  exportFile: (projectId: string, reportId: string, table?: number) =>
    apiFile(`${base(projectId)}/reports/${encodeURIComponent(reportId)}/export${table === undefined ? "" : `?format=csv&block=${table}`}`),
  save: (projectId: string, days: number) =>
    apiClient<StatusReportMeta>(`${base(projectId)}/reports`, { method: "POST", body: JSON.stringify({ days }) }),
};
