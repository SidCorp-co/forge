import type { ProjectStatus } from "@forge/contracts/project-status";
import type { ReportDocument } from "@forge/contracts/report-templates";
import type { StatusReportDetail, StatusReportMeta, StatusReportNarrative } from "@forge/contracts/status-reports";
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
  /** The templates this build offers, each with the names of the params it takes. */
  templates: (projectId: string) => apiClient<{ templates: TemplateListing[] }>(`/projects/${encodeURIComponent(projectId)}/report-templates`),
  /**
   * Runs one template's queries as the reader and answers its document, with the narrative and each
   * block's finding core wrote from them, and how that narrative came to be.
   */
  runTemplate: (projectId: string, templateId: string, params: Record<string, string | number | boolean>) =>
    apiClient<{ document: ReportDocument; narrative: StatusReportNarrative }>(`/projects/${encodeURIComponent(projectId)}/report-templates/${encodeURIComponent(templateId)}/runs`, {
      method: "POST",
      body: JSON.stringify({ params }),
    }),
};

/** One template as core lists it (`GET /projects/:id/report-templates`). */
export interface TemplateListing {
  id: string;
  version: number;
  title: string;
  params: string[];
}

