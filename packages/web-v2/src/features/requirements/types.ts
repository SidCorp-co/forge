// The requirement vocabulary and response shapes are core's own, declared once in @forge/contracts.
import type { RequirementSpec, RequirementSummary } from '@forge/contracts/requirements';
import type { WrittenLang } from '@forge/contracts/written-lang';

export type {
  RequirementAreaRef,
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

/** A title alone creates one (REQ-34 BC-17): its reason is asked afterwards, its criteria drafted. */
export interface CreateRequirementBody {
  title: string;
  reason?: string;
  spec?: RequirementSpec;
  tldr?: string;
  criteria?: { body: string; form?: 'statement' | 'scenario' }[];
}

/** One sign-off move on a requirement: the revision it acts on, the reason a return, defer, undefer
 *  or drop owes, and the reason a signer may give an accept, agree or re-pin (ISS-84). */
export type RequirementAction =
  | { kind: 'propose'; revision: number }
  | { kind: 'accept'; revision: number; reason: string }
  | { kind: 'return'; revision: number; reason: string }
  | { kind: 'agree'; revision: number; reason?: string }
  | { kind: 'repin'; revision: number; reason?: string }
  | { kind: 'defer'; reason: string; targetPhase?: string }
  | { kind: 'undefer'; reason: string }
  | { kind: 'accept-delivery'; revision: number; reason?: string; byDecision?: boolean }
  | { kind: 'start-delivery'; reason?: string }
  | { kind: 'mark-delivered'; reason?: string }
  | { kind: 'drop'; reason: string };

/** A revision write: what a new draft or an edit of the open one sends (`revision-draft.ts:revisionWrite`). */
export interface RevisionWriteBody {
  reason: string | null;
  tldr: string | null;
  changeSummary: string | null;
  writtenLang?: WrittenLang;
  criteria: { code?: string; body: string; form: 'statement' | 'scenario' }[];
}

/** `GET /projects/:id/interface`, read for the contracts a requirement may link: those it publishes and consumes. */
export interface ProjectInterfaceRead {
  declared: boolean;
  document: { publishes: Record<string, unknown>; consumes: { contract: string }[] } | null;
}
