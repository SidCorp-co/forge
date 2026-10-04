export type {
  ReleaseApprovalView,
  ReleaseAttemptView,
  ReleaseAttentionGroup,
  ReleaseContentGroup,
  ReleaseDetail,
  ReleaseGateView,
  ReleaseIssueView,
  ReleaseListResponse,
  ReleaseNoteEntry,
  ReleaseResponse,
  ReleaseSummary,
} from "@forge/contracts/releases";

export type ReleaseDecisionBody = { decision: "approve" } | { decision: "return"; reason: string };
