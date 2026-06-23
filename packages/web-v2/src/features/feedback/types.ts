// web-v2 feature module: feedback — types for feedback_reports REST surface.
// Shape verified against `GET /api/feedback-reports` in
// `packages/core/src/feedback/routes.ts`.

type BadgeTone = "neutral" | "accent" | "cobalt" | "green" | "red" | "amber";

export type FeedbackKind =
  | "unclear_step"
  | "skill_gap"
  | "friction"
  | "learning"
  | "blocker"
  | "policy";

export type FeedbackSeverity = "low" | "medium" | "high" | "critical";

export type FeedbackTarget =
  | "skill"
  | "pipeline"
  | "tool"
  | "memory"
  | "issue"
  | "project"
  | "forge";

export interface FeedbackReport {
  id: string;
  kind: FeedbackKind;
  severity: FeedbackSeverity;
  target: FeedbackTarget;
  targetRef: string | null;
  summary: string;
  detail: string | null;
  suggestion: string | null;
  signalKey: string;
  sessionId: string | null;
  reviewedAt: string | null;
  createdAt: string;
}

export interface FeedbackFilters {
  kind?: FeedbackKind;
  severity?: FeedbackSeverity;
  target?: FeedbackTarget;
}

export function kindToBadgeTone(kind: FeedbackKind): BadgeTone {
  switch (kind) {
    case "blocker":
      return "red";
    case "skill_gap":
    case "friction":
      return "amber";
    case "learning":
      return "green";
    default:
      return "neutral";
  }
}

export function severityToBadgeTone(severity: FeedbackSeverity): BadgeTone {
  switch (severity) {
    case "critical":
      return "red";
    case "high":
      return "amber";
    case "medium":
      return "cobalt";
    default:
      return "neutral";
  }
}
