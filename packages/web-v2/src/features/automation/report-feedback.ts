import type { AgentReportView } from "@forge/contracts/agent-reports";
import { enumLabel } from "@/design/vocabulary";
import type { FeedbackDraft } from "@/features/feedback/components/feedback-form";

const FEEDBACK_KIND_OF: Record<AgentReportView["kind"], FeedbackDraft["kind"]> = {
  bug: "bug",
  suggestion: "idea",
  learning: "idea",
  friction: "change_request",
  skill_gap: "change_request",
  unclear_step: "change_request",
  redundant_step: "change_request",
};

export function feedbackDraftOf(r: AgentReportView): FeedbackDraft {
  return {
    kind: FEEDBACK_KIND_OF[r.kind],
    severity: r.severity,
    targetType: "screen",
    target: [enumLabel("agentReportTarget", r.target), r.targetRef].filter(Boolean).join(" "),
    title: r.summary.slice(0, 300),
    body: [r.detail, r.suggestion ? `Suggested: ${r.suggestion}` : null].filter(Boolean).join("\n\n"),
  };
}
