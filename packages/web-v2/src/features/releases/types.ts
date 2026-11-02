export type {
  ReleaseApprovalView,
  ReleaseAttemptView,
  ReleaseAttentionGroup,
  ReleaseContentGroup,
  ReleaseContinuation,
  ReleaseCutView,
  ReleaseDetail,
  ReleaseDraftApprovalView,
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

export type ReleaseDecisionBody = { decision: "approve" | "return"; reason: string };
export type { ReleasePage, ReleasePageViewKind } from "@forge/contracts/release-page";
