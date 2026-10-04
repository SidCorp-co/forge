"use client";

import type { TriageAgentReportRequest } from "@forge/contracts/agent-reports";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { formatApiError } from "@/lib/api/error";
import { useToast } from "@/providers/toast-provider";
import { agentReportsApi } from "./api";
import type { AgentReportFilters } from "./types";

export function useAgentReports(projectId: string | undefined, filters?: AgentReportFilters) {
  return useQuery({
    queryKey: ["agent-reports", projectId, filters],
    queryFn: () => agentReportsApi.list(projectId as string, filters),
    enabled: !!projectId,
  });
}

const DONE: Record<TriageAgentReportRequest["act"], string> = {
  file: "Filed",
  dismiss: "Dismissed",
  duplicate: "Marked a duplicate",
  reopen: "Reopened",
};

export function useTriageAgentReport(projectId: string | undefined) {
  const qc = useQueryClient();
  const { toast } = useToast();
  return useMutation({
    mutationFn: ({ id, act }: { id: string; act: TriageAgentReportRequest }) => agentReportsApi.triage(id, act),
    onSuccess: ({ effect }, { act }) => {
      qc.invalidateQueries({ queryKey: ["agent-reports", projectId] });
      toast({ title: effect.issue ? `${DONE[act.act]} as ${effect.issue.key}` : DONE[act.act], tone: "success" });
    },
    onError: (err) => {
      toast({ title: "Triage refused", description: formatApiError(err), tone: "error" });
    },
  });
}
