import type { FeedbackReport } from "@/features/feedback/types";
import type { ScheduleRun } from "@/features/schedules/types";

export const IMPROVEMENT_FILTERS = ["all", "feedback", "proposals", "done"] as const;
export type ImprovementFilter = (typeof IMPROVEMENT_FILTERS)[number];

export type ImprovementState = "feedback" | "proposal" | "done";

export type ImprovementRow =
  | {
      id: string;
      source: "feedback";
      title: string;
      from: string;
      state: ImprovementState;
      at: string;
      report: FeedbackReport;
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

function feedbackRow(r: FeedbackReport): ImprovementRow {
  return {
    id: `feedback:${r.id}`,
    source: "feedback",
    title: r.summary,
    from: `${r.kind.replace(/_/g, " ")} · ${r.target}${r.targetRef ? ` ${r.targetRef}` : ""}`,
    state: r.reviewedAt ? "done" : "feedback",
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

export function improvementRows(feedback: readonly FeedbackReport[], loops: readonly LoopRuns[]): ImprovementRow[] {
  return [...feedback.map(feedbackRow), ...loops.flatMap(proposalRows)].sort((a, b) => b.at.localeCompare(a.at));
}

export function matchesFilter(row: ImprovementRow, f: ImprovementFilter): boolean {
  if (f === "all") return true;
  if (f === "done") return row.state === "done";
  return f === "feedback" ? row.state === "feedback" : row.state === "proposal";
}

export function issueFromFeedback(r: FeedbackReport): { title: string; description: string } {
  const parts = [r.detail, r.suggestion ? `Suggested: ${r.suggestion}` : null, `Feedback ${r.id} (${r.kind}, ${r.severity}).`];
  return { title: r.summary.slice(0, 200), description: parts.filter(Boolean).join("\n\n") };
}
