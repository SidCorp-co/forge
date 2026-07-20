// web-v2 feature module: feedback — types for feedback_reports REST surface.
// Shape verified against `GET /api/feedback-reports` in
// `packages/core/src/feedback/routes.ts`.

type BadgeTone = "neutral" | "accent" | "cobalt" | "green" | "red" | "amber";

export type FeedbackKind =
  | "friction"
  | "bug"
  | "skill_gap"
  | "unclear_step"
  | "redundant_step"
  | "learning"
  | "suggestion";

export type FeedbackSeverity = "low" | "medium" | "high";

export type FeedbackTarget =
  | "skill"
  | "prompt"
  | "tool"
  | "doc"
  | "orientation"
  | "pipeline"
  | "other";

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
  linkedIssueId: string | null;
  createdAt: string;
}

export interface FeedbackFilters {
  kind?: FeedbackKind;
  severity?: FeedbackSeverity;
  target?: FeedbackTarget;
}

export function kindToBadgeTone(kind: FeedbackKind): BadgeTone {
  switch (kind) {
    case "bug":
    case "skill_gap":
    case "friction":
    case "redundant_step":
      return "amber";
    case "learning":
    case "suggestion":
      return "green";
    case "unclear_step":
      return "cobalt";
    default:
      return "neutral";
  }
}

export function severityToBadgeTone(severity: FeedbackSeverity): BadgeTone {
  switch (severity) {
    case "high":
      return "amber";
    case "medium":
      return "cobalt";
    default:
      return "neutral";
  }
}
