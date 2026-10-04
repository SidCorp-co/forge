// The feedback vocabulary and response shapes are core's own, declared once in @forge/contracts (ISS-59).
import type { FeedbackRouteWrite, FeedbackTriage } from "@forge/contracts/feedback";

export type {
  CreateFeedbackRequest,
  FeedbackDedup,
  FeedbackRouteWrite,
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
  SimilarFeedbackResponse,
} from "@forge/contracts/feedback";

/** One act a person takes on an item from its page; each answers the item as it reads next. */
export type FeedbackAction =
  | { kind: "triage"; triage: FeedbackTriage }
  | { kind: "route"; write: FeedbackRouteWrite }
  | { kind: "verify"; note?: string }
  | { kind: "reopen"; reason: string }
  | { kind: "redact" };
