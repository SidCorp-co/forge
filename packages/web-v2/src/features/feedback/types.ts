// The feedback vocabulary and response shapes are core's own, declared once in @forge/contracts (ISS-59).
import type { FeedbackRetargetRequest, FeedbackTriage } from "@forge/contracts/feedback";

export type {
  CreateFeedbackRequest,
  FeedbackDedup,
  FeedbackEndpointsResponse,
  FeedbackEndpointView,
  FeedbackKind,
  FeedbackListResponse,
  FeedbackMessageAudience,
  FeedbackMessagePreview,
  FeedbackMessagePreviewResponse,
  FeedbackMessageView,
  FeedbackPhase,
  FeedbackResponse,
  FeedbackRetargetRequest,
  FeedbackRoute,
  FeedbackSeverity,
  FeedbackReporterView,
  FeedbackSummary,
  FeedbackTargetType,
  FeedbackTriage,
  FeedbackView,
  SimilarFeedbackDraft,
  SimilarFeedbackResponse,
} from "@forge/contracts/feedback";
export type {
  ForgeFeedbackFiled,
  ForgeFeedbackItem,
  ForgeFeedbackList,
  ForgeFeedbackRequest,
} from "@forge/contracts/forge-feedback";

/** One act a person takes on an item from its page; each answers the item as it reads next. */
export type FeedbackAction =
  | { kind: "triage"; triage: FeedbackTriage }
  | { kind: "retarget"; request: FeedbackRetargetRequest }
  | { kind: "snooze"; until: string; reason: string }
  | { kind: "verify"; note?: string }
  | { kind: "verify-ask" }
  | { kind: "reopen"; reason: string }
  | { kind: "clarify"; prompt: string; needed: string; recommended: string }
  | { kind: "redact" };
