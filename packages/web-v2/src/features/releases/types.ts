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

/** `carry` is an approval's only (ISS-914): the unproven criteria carried by the approver's word. */
export type ReleaseDecisionBody = { decision: "approve" | "return"; reason: string; carry?: { all: true; why: string } };
export type { ReleasePage, ReleasePageViewKind } from "@forge/contracts/release-page";
