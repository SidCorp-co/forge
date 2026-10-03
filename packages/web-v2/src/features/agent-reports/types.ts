// web-v2 feature module: agent reports — types for the agent_reports REST surface.
// Shape verified against `GET /api/agent-reports` in
// `packages/core/src/agent-reports/routes.ts`.

type BadgeTone = "neutral" | "accent" | "cobalt" | "green" | "red" | "amber";

export type AgentReportKind =
  | "friction"
  | "bug"
  | "skill_gap"
  | "unclear_step"
  | "redundant_step"
  | "learning"
  | "suggestion";

export type AgentReportSeverity = "low" | "medium" | "high";

export type AgentReportTarget =
  | "skill"
  | "prompt"
  | "tool"
  | "doc"
  | "orientation"
  | "pipeline"
  | "other";

export interface AgentReport {
  id: string;
  kind: AgentReportKind;
  severity: AgentReportSeverity;
  target: AgentReportTarget;
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

export interface AgentReportFilters {
  kind?: AgentReportKind;
  severity?: AgentReportSeverity;
  target?: AgentReportTarget;
}

export function kindToBadgeTone(kind: AgentReportKind): BadgeTone {
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

export function severityToBadgeTone(severity: AgentReportSeverity): BadgeTone {
  switch (severity) {
    case "high":
      return "amber";
    case "medium":
      return "cobalt";
    default:
      return "neutral";
  }
}
