import type { AgentReportTriageEffect, TriageAgentReportRequest } from "@forge/contracts/agent-reports";
import { apiClient } from "@/lib/api/client";
import type { AgentReport, AgentReportFilters } from "./types";

function buildQuery(projectId: string, filters?: AgentReportFilters, limit?: number): string {
  const params = new URLSearchParams({ projectId });
  if (filters?.kind) params.set("kind", filters.kind);
  if (filters?.severity) params.set("severity", filters.severity);
  if (filters?.target) params.set("target", filters.target);
  if (filters?.triage) params.set("triage", filters.triage);
  if (limit) params.set("limit", String(limit));
  return params.toString();
}

export const agentReportsApi = {
  /** `GET /api/agent-reports?projectId=&kind=&severity=&target=&triage=&limit=` */
  list: (projectId: string, filters?: AgentReportFilters, limit?: number) =>
    apiClient<AgentReport[]>(`/agent-reports?${buildQuery(projectId, filters, limit)}`),

  /** `POST /api/agent-reports/:id/triage`: file, dismiss, mark duplicate or reopen one report. */
  triage: (id: string, act: TriageAgentReportRequest) =>
    apiClient<{ effect: AgentReportTriageEffect }>(`/agent-reports/${id}/triage`, {
      method: "POST",
      body: JSON.stringify(act),
    }),
};
