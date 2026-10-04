import type { IssueStatusTone } from "@forge/contracts/issue-vocabulary";
import type {
  RequirementDeferral,
  RequirementFeedbackItem,
  RequirementHistoryEntry,
  RequirementStanding,
  RequirementStatus,
} from '@forge/contracts/requirements';

export type { RequirementFeedbackItem, RequirementStatus };
export type RevisionState = 'draft' | 'proposed' | 'current' | 'superseded';
export type DeliveryPhase = 'agreed' | 'in_delivery' | 'delivered';
export interface RequirementSpec { goal?: string; personas?: string[]; scopeIn?: string[]; scopeOut?: string[] }
export interface RequirementDelivery { phase: DeliveryPhase | null; liveIssues: number; startedIssues: number; closedIssues: number; criteriaCoverage: { criteria: number; passing: number; judged: number } }
export interface RequirementSummary {
  id: string; key: string; title: string; status: RequirementStatus;
  currentRevision: number | null;
  latestRevision: { revision: number; state: RevisionState } | null;
  delivery: RequirementDelivery;
  createdAt: string; updatedAt: string;
  /** Where it stands, derived in core (`requirements/standing.ts`): group, waiting on, facts, coverage. */
  standing: RequirementStanding;
}
export interface RequirementCriterion { id: string; code: string; body: string; form: 'statement' | 'scenario'; sinceRevision: number; retiredRevision: number | null }
export interface RequirementRevision {
  revision: number; state: RevisionState; baseRevision: number | null;
  spec: RequirementSpec; tldr: string | null; changeSummary: string | null; reason: string;
  authorId: string; authorName: string | null; authorKind: 'human' | 'agent'; createdAt: string;
  proposedAt: string | null; decidedBy: string | null; decidedByName: string | null; decidedAt: string | null; returnReason: string | null;
  acceptReason: string | null;
  fromSuggestionId: string | null;
  criteria: RequirementCriterion[];
}
export interface RequirementPin { kind: 'workflow-design' | 'contract-version'; workflowId: string | null; flow: string | null; designRevision: number | null; providerProjectId: string | null; contractSlug: string | null; contractVersion: string | null }
export interface RequirementBaseline { revision: number; seq: number; act: 'agree' | 'repin'; agreedBy: string; agreedByName: string | null; agreedAt: string; reason: string | null; pins: RequirementPin[] }
export interface RequirementWorkflowLink { workflowId: string; flow: string; title: string; designStatus: 'draft'|'proposed'|'approved'|'returned'|null; approvedRevision: number | null }
export interface RequirementIssueLink {
  issueId: string;
  displayId: string;
  title: string;
  status: string;
  /** The status's tone on this project (core `issues/standing.ts:toneOf`): awaiting_release is amber only where a release needs approval. */
  tone: IssueStatusTone;
  plannedRevision: number | null;
  changedSincePlan: boolean;
}
export interface RequirementDetail extends RequirementSummary {
  revisions: RequirementRevision[];   // newest first
  criteria: RequirementCriterion[];   // of the current revision; [] when none is current
  workflows: RequirementWorkflowLink[];
  baselines: RequirementBaseline[];   // newest first
  issues: RequirementIssueLink[];
  canSignOff: boolean;                // the viewer is a person allowed to accept / return / agree
  history: RequirementHistoryEntry[];  // newest first
  readiness: { revision: number; ready: boolean; failed: string[]; suggestionId: string; decidedAt: string | null } | null;
  deferral: RequirementDeferral | null; // the defer it stands on, while deferred
  feedback: RequirementFeedbackItem[];
}

export interface RequirementList { requirements: RequirementSummary[]; returned: number }

export interface CreateRequirementBody {
  title: string;
  reason: string;
  spec?: RequirementSpec;
  tldr?: string;
  criteria: { body: string; form?: 'statement' | 'scenario' }[];
}

/** One sign-off move on a requirement: the revision it acts on, and the reason a return carries. */
export type RequirementAction =
  | { kind: 'propose'; revision: number }
  | { kind: 'accept'; revision: number }
  | { kind: 'return'; revision: number; reason: string }
  | { kind: 'agree'; revision: number }
  | { kind: 'repin'; revision: number }
  | { kind: 'undefer' };
