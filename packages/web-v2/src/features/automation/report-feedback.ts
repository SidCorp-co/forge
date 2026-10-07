import type { AgentReportView } from "@forge/contracts/agent-reports";
import { enumLabel } from "@/design/vocabulary";
import { productCopy } from "@/lib/i18n/product-copy";
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

export function feedbackDraftOf(r: AgentReportView, language = "en"): FeedbackDraft {
  return {
    kind: FEEDBACK_KIND_OF[r.kind],
    severity: r.severity,
    targetType: "screen",
    target: [enumLabel("agentReportTarget", r.target, language), r.targetRef].filter(Boolean).join(" "),
    title: r.summary.slice(0, 300),
    body: [r.detail, r.suggestion ? productCopy(language)("schedules.report.suggested", { text: r.suggestion }) : null].filter(Boolean).join("\n\n"),
  };
}
