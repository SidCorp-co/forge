export type {
  ReleaseApprovalView,
  ReleaseAttemptView,
  ReleaseAttentionGroup,
  ReleaseContentGroup,
  ReleaseContinuation,
  ReleaseCutView,
  ReleaseDetail,
  ReleaseFeedbackView,
  ReleaseGateView,
  ReleaseIssueView,
  ReleaseListResponse,
  ReleaseNoteEntry,
  ReleaseRequirementView,
  ReleaseResponse,
  ReleaseSummary,
  ReleaseVersionCarrier,
} from "@forge/contracts/releases";

export type ReleaseDecisionBody = { decision: "approve" } | { decision: "return"; reason: string };
export type { ReleasePage, ReleasePageViewKind } from "@forge/contracts/release-page";
