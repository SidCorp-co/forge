export type {
  ReleaseApprovalView,
  ReleaseAttemptView,
  ReleaseAttention,
  ReleaseContentGroup,
  ReleaseCriteriaTotals,
  ReleaseCriterionView,
  ReleaseDetail,
  ReleaseGateView,
  ReleaseIssueView,
  ReleaseListResponse,
  ReleaseNoteEntry,
  ReleasePerson,
  ReleaseProduction,
  ReleaseProof,
  ReleaseRequirementView,
  ReleaseResponse,
  ReleaseState,
  ReleaseSummary,
  ReleaseWaiting,
} from "@forge/contracts/releases";
export type { ReleaseRoster, ReleaseRosterEntry } from "./roster";

export type ReleaseDecisionBody = { decision: "approve" } | { decision: "return"; reason: string };
