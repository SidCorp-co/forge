import type { AgentReportTriageEffect, TriageAgentReportRequest } from "@forge/contracts/agent-reports";
import { apiClient } from "@/lib/api/client";

export const agentReportsApi = {
  /** `POST /api/agent-reports/:id/triage`: file, dismiss, mark duplicate or reopen one report. */
  triage: (id: string, act: TriageAgentReportRequest) =>
    apiClient<{ effect: AgentReportTriageEffect }>(`/agent-reports/${id}/triage`, {
      method: "POST",
      body: JSON.stringify(act),
    }),
};
