export type {
  ReleaseApprovalView,
  ReleaseAttemptView,
  ReleaseAttentionGroup,
  ReleaseContentGroup,
  ReleaseDetail,
  ReleaseFeedbackView,
  ReleaseGateView,
  ReleaseIssueView,
  ReleaseListResponse,
  ReleaseNoteEntry,
  ReleaseResponse,
  ReleaseSummary,
} from "@forge/contracts/releases";

export type ReleaseDecisionBody = { decision: "approve" } | { decision: "return"; reason: string };
