import { enumLabel } from "@/design/vocabulary";
import type { AgentReport } from "@/features/agent-reports/types";
import type { FireProposal, ReportStanding } from "@/features/automation/types";
import type { FeedbackDraft } from "@/features/feedback/components/feedback-form";

export const IMPROVEMENT_FILTERS = ["all", "reports", "proposals", "done"] as const;
export type ImprovementFilter = (typeof IMPROVEMENT_FILTERS)[number];

export type ImprovementState = "report" | "proposal" | "done";

export type ImprovementRow =
  | {
      id: string;
      source: "report";
      title: string;
      from: string;
      state: ImprovementState;
      at: string;
      report: ReportStanding;
    }
  | {
      id: string;
      source: "proposal";
      title: string;
      from: string;
      state: ImprovementState;
      at: string;
      sessionId: string;
    };

const AWAITING_TRIAGE: ReadonlySet<ReportStanding["attentionGroup"]> = new Set(["needs_you", "waiting"]);

function reportRow(r: ReportStanding): ImprovementRow {
  return {
    id: `report:${r.id}`,
    source: "report",
    title: r.summary,
    from: `${enumLabel("agentReportKind", r.kind)} · ${enumLabel("agentReportTarget", r.target)}${r.targetRef ? ` ${r.targetRef}` : ""}`,
    state: AWAITING_TRIAGE.has(r.attentionGroup) ? "report" : "done",
    at: r.createdAt,
    report: r,
  };
}

function proposalRow(p: FireProposal, i: number, loopTitle: (scheduleId: string) => string): ImprovementRow {
  return {
    id: `proposal:${p.fireId}:${i}`,
    source: "proposal",
    title: p.summary,
    from: `${loopTitle(p.scheduleId)} · ${p.skill}`,
    state: p.kind === "proposed" ? "proposal" : "done",
    at: p.at,
    sessionId: p.sessionId,
  };
}

/** The read model's reports and the proposals of the fires it served, on one list, newest first. */
export function improvementRows(
  reports: readonly ReportStanding[],
  proposals: readonly FireProposal[],
  loopTitle: (scheduleId: string) => string,
): ImprovementRow[] {
  return [...reports.map(reportRow), ...proposals.map((p, i) => proposalRow(p, i, loopTitle))].sort((a, b) =>
    b.at.localeCompare(a.at),
  );
}

export function matchesFilter(row: ImprovementRow, f: ImprovementFilter): boolean {
  if (f === "all") return true;
  if (f === "done") return row.state === "done";
  return f === "reports" ? row.state === "report" : row.state === "proposal";
}

const FEEDBACK_KIND_OF: Record<AgentReport["kind"], FeedbackDraft["kind"]> = {
  bug: "bug",
  suggestion: "idea",
  learning: "idea",
  friction: "change_request",
  skill_gap: "change_request",
  unclear_step: "change_request",
  redundant_step: "change_request",
};

export function feedbackDraftOf(r: AgentReport): FeedbackDraft {
  return {
    kind: FEEDBACK_KIND_OF[r.kind],
    severity: r.severity,
    targetType: "screen",
    target: [enumLabel("agentReportTarget", r.target), r.targetRef].filter(Boolean).join(" "),
    title: r.summary.slice(0, 300),
    body: [r.detail, r.suggestion ? `Suggested: ${r.suggestion}` : null].filter(Boolean).join("\n\n"),
  };
}
