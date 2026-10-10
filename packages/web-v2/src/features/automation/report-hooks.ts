
import type { TriageAgentReportRequest } from "@forge/contracts/agent-reports";
import { automationKeys } from "./queries";
import { formatRefusal } from "@/lib/api/error";
import { useCopy } from "@/lib/i18n/interface-language";
import type { ProductCopyKey } from "@/lib/i18n/product-copy";
import { useToastWrite } from "@/providers/toast-write";
import { agentReportsApi } from "./report-api";

const DONE: Record<TriageAgentReportRequest["act"], ProductCopyKey> = {
  file: "schedules.report.done.file",
  dismiss: "schedules.report.done.dismiss",
  duplicate: "schedules.report.done.duplicate",
  reopen: "schedules.report.done.reopen",
};

export function useTriageAgentReport(projectId: string | undefined) {
  const t = useCopy();
  return useToastWrite(({ id, act }: { id: string; act: TriageAgentReportRequest }) => agentReportsApi.triage(id, act), {
    touches: [automationKeys.agentReports(projectId), automationKeys.project(projectId)],
    said: ({ effect }, { act }) => (effect.issue ? t("schedules.report.doneAs", { done: t(DONE[act.act]), key: effect.issue.key }) : t(DONE[act.act])),
    failed: t("schedules.report.refused"),
    describe: formatRefusal,
  });
}
