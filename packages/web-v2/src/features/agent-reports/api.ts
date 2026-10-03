import { apiClient } from "@/lib/api/client";
import type { AgentReportFilters, AgentReport } from "./types";

function buildQuery(projectId: string, filters?: AgentReportFilters, limit?: number): string {
  const params = new URLSearchParams({ projectId });
  if (filters?.kind) params.set("kind", filters.kind);
  if (filters?.severity) params.set("severity", filters.severity);
  if (filters?.target) params.set("target", filters.target);
  if (limit) params.set("limit", String(limit));
  return params.toString();
}

export const agentReportsApi = {
  /** `GET /api/agent-reports?projectId=&kind=&severity=&target=&limit=` */
  list: (projectId: string, filters?: AgentReportFilters, limit?: number) =>
    apiClient<AgentReport[]>(`/agent-reports?${buildQuery(projectId, filters, limit)}`),

  /** `POST /api/agent-reports/:id/reviewed` — toggle reviewed state, optionally linking the issue it was folded into. */
  markReviewed: (id: string, reviewed: boolean, linkedIssueId?: string) =>
    apiClient<{ id: string; reviewedAt: string | null; linkedIssueId: string | null }>(
      `/agent-reports/${id}/reviewed`,
      {
        method: "POST",
        body: JSON.stringify({ reviewed, ...(linkedIssueId ? { linkedIssueId } : {}) }),
      },
    ),
};
