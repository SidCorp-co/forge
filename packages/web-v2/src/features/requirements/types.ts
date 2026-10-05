// The requirement vocabulary and response shapes are core's own, declared once in @forge/contracts.
import type { RequirementSpec, RequirementSummary } from '@forge/contracts/requirements';

export type {
  DeliveryPhase,
  RequirementBaseline,
  RequirementCriterion,
  RequirementDelivery,
  RequirementDetail,
  RequirementFeedbackItem,
  RequirementIssueLink,
  RequirementRevision,
  RequirementSpec,
  RequirementStatus,
  RequirementSummary,
  RequirementWorkflowLink,
  RevisionState,
} from '@forge/contracts/requirements';

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
  | { kind: 'defer'; reason: string; targetPhase?: string }
  | { kind: 'undefer' };
