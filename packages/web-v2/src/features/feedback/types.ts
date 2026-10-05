// The feedback vocabulary and response shapes are core's own, declared once in @forge/contracts (ISS-59).
import type { FeedbackTriage } from "@forge/contracts/feedback";

export type {
  CreateFeedbackRequest,
  FeedbackDedup,
  FeedbackKind,
  FeedbackListResponse,
  FeedbackPhase,
  FeedbackPromoteEffect,
  FeedbackResponse,
  FeedbackRoute,
  FeedbackSeverity,
  FeedbackSummary,
  FeedbackTargetType,
  FeedbackTriage,
  FeedbackView,
  PromoteAgentReportRequest,
} from "@forge/contracts/feedback";

/** One act a person takes on an item from its page; each answers the item as it reads next. */
export type FeedbackAction =
  | { kind: "triage"; triage: FeedbackTriage }
  | { kind: "verify"; note?: string }
  | { kind: "verify-ask" }
  | { kind: "reopen"; reason: string }
  | { kind: "redact" };
