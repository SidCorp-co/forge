import { enumLabel } from "@/design/vocabulary";
import type { AgentReport } from "@/features/agent-reports/types";
import type { FeedbackDraft } from "@/features/feedback/components/feedback-form";
import type { ScheduleRun } from "@/features/schedules/types";

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
      report: AgentReport;
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

export interface LoopRuns {
  title: string;
  runs: ScheduleRun[];
}

function reportRow(r: AgentReport): ImprovementRow {
  return {
    id: `report:${r.id}`,
    source: "report",
    title: r.summary,
    from: `${enumLabel("agentReportKind", r.kind)} · ${enumLabel("agentReportTarget", r.target)}${r.targetRef ? ` ${r.targetRef}` : ""}`,
    state: r.reviewedAt ? "done" : "report",
    at: r.createdAt,
    report: r,
  };
}

function proposalRows(loop: LoopRuns): ImprovementRow[] {
  return loop.runs.flatMap((run) =>
    (run.stewardReport?.actions ?? []).flatMap((a, i): ImprovementRow[] =>
      a.kind === "proposed" || a.kind === "applied"
        ? [
            {
              id: `proposal:${run.sessionId}:${i}`,
              source: "proposal",
              title: a.summary,
              from: `${loop.title} · ${a.skill}`,
              state: a.kind === "proposed" ? "proposal" : "done",
              at: run.finishedAt ?? run.startedAt ?? "",
              sessionId: run.sessionId,
            },
          ]
        : [],
    ),
  );
}

export function improvementRows(reports: readonly AgentReport[], loops: readonly LoopRuns[]): ImprovementRow[] {
  return [...reports.map(reportRow), ...loops.flatMap(proposalRows)].sort((a, b) => b.at.localeCompare(a.at));
}

export function matchesFilter(row: ImprovementRow, f: ImprovementFilter): boolean {
  if (f === "all") return true;
  if (f === "done") return row.state === "done";
  return f === "reports" ? row.state === "report" : row.state === "proposal";
}

export function issueFromReport(r: AgentReport): { title: string; description: string } {
  const parts = [r.detail, r.suggestion ? `Suggested: ${r.suggestion}` : null, `Agent report ${r.id} (${r.kind}, ${r.severity}).`];
  return { title: r.summary.slice(0, 200), description: parts.filter(Boolean).join("\n\n") };
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
