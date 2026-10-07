"use client";

import type { TriageAgentReportRequest } from "@forge/contracts/agent-reports";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { automationKey } from "@/features/automation/hooks";
import { formatRefusal } from "@/lib/api/error";
import { useCopy } from "@/lib/i18n/interface-language";
import type { ProductCopyKey } from "@/lib/i18n/product-copy";
import { useToast } from "@/providers/toast-provider";
import { agentReportsApi } from "./report-api";

const DONE: Record<TriageAgentReportRequest["act"], ProductCopyKey> = {
  file: "schedules.report.done.file",
  dismiss: "schedules.report.done.dismiss",
  duplicate: "schedules.report.done.duplicate",
  reopen: "schedules.report.done.reopen",
};

export function useTriageAgentReport(projectId: string | undefined) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const t = useCopy();
  return useMutation({
    mutationFn: ({ id, act }: { id: string; act: TriageAgentReportRequest }) => agentReportsApi.triage(id, act),
    onSuccess: ({ effect }, { act }) => {
      qc.invalidateQueries({ queryKey: ["agent-reports", projectId] });
      qc.invalidateQueries({ queryKey: automationKey(projectId) });
      toast({ title: effect.issue ? t("schedules.report.doneAs", { done: t(DONE[act.act]), key: effect.issue.key }) : t(DONE[act.act]), tone: "success" });
    },
    onError: (err) => {
      toast({ title: t("schedules.report.refused"), description: formatRefusal(err), tone: "error" });
    },
  });
}
