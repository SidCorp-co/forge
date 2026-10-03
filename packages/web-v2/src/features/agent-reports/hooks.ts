"use client";

// web-v2 feature module: agent reports — React Query hooks.
// Keyed `['agent-reports', projectId]`; mark-reviewed mutation invalidates on success.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/providers/toast-provider";
import { formatApiError } from "@/lib/api/error";
import { agentReportsApi } from "./api";
import type { AgentReportFilters } from "./types";

export function useAgentReports(projectId: string | undefined, filters?: AgentReportFilters) {
  return useQuery({
    queryKey: ["agent-reports", projectId, filters],
    queryFn: () => agentReportsApi.list(projectId as string, filters),
    enabled: !!projectId,
  });
}

export function useMarkAgentReportReviewed(projectId: string | undefined) {
  const qc = useQueryClient();
  const { toast } = useToast();
  return useMutation({
    mutationFn: ({ id, reviewed, linkedIssueId }: { id: string; reviewed: boolean; linkedIssueId?: string }) =>
      agentReportsApi.markReviewed(id, reviewed, linkedIssueId),
    onSuccess: (_data, { reviewed }) => {
      qc.invalidateQueries({ queryKey: ["agent-reports", projectId] });
      toast({ title: reviewed ? "Marked as reviewed" : "Marked as unreviewed", tone: "success" });
    },
    onError: (err) => {
      toast({ title: "Action failed", description: formatApiError(err), tone: "error" });
    },
  });
}
