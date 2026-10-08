import type { ProjectStatus } from "@forge/contracts/project-status";
import type { ReportDocument } from "@forge/contracts/report-templates";
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
  /** Keeps a template's runs as a report; core reads each run back as the saver and judges the narrative against them. */
  /** The templates this build offers, each with the names of the params it takes. */
  templates: (projectId: string) => apiClient<{ templates: TemplateListing[] }>(`/projects/${encodeURIComponent(projectId)}/report-templates`),
  /** Runs one template's queries as the reader and answers its document; the narrative is left empty. */
  runTemplate: (projectId: string, templateId: string, params: Record<string, string | number | boolean>) =>
    apiClient<{ document: ReportDocument }>(`/projects/${encodeURIComponent(projectId)}/report-templates/${encodeURIComponent(templateId)}/runs`, {
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

