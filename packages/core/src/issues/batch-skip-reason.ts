import type { TransitionErrorCode } from './apply-transition.js';

/** The wire word `PATCH /issues/batch` reports per refusal. It sits beside no route because the
 *  map is exhaustive over `TransitionErrorCode` and is missed inside a 500-line route file. */
export const BATCH_SKIP_BY_CODE = {
  NO_OP: 'no_op',
  ILLEGAL_TRANSITION: 'illegal_transition',
  TRANSITION_REASON_REQUIRED: 'transition_reason_required',
  WAITING_KIND_REQUIRED: 'waiting_kind_required',
  WAITING_KIND_NOT_APPLICABLE: 'waiting_kind_not_applicable',
  STALE_TRANSITION: 'stale',
  NO_WORK_EVIDENCE: 'no_work_evidence',
  RELEASE_RECORD_REQUIRED: 'release_record_required',
  CLOSE_REQUIRES_SHIPPED: 'close_requires_shipped',
  ISSUE_ARCHIVED: 'issue_archived',
  OPEN_QUESTIONS: 'open_questions',
  VOID_REASON_REQUIRED: 'void_reason_required',
  NO_HOLDER: 'no_holder',
  ISSUE_BLOCKED: 'issue_blocked',
  WORKFLOW_DESIGN_NOT_APPROVED: 'workflow_design_not_approved',
  CONTRACT_WAIT_UNSETTLED: 'contract_wait_unsettled',
  PLAN_REQUIRED: 'plan_required',
  APPROVE_PERMISSION_REQUIRED: 'approve_permission_required',
  VERDICT_IDENTITY_REQUIRED: 'verdict_identity_required',
  VERDICT_PREDATES_REOPEN: 'verdict_predates_reopen',
  VERDICT_IDENTITY_NOT_ADMISSIBLE: 'verdict_identity_not_admissible',
  VERDICT_UNCORROBORATED: 'verdict_uncorroborated',
  VERDICT_DRAFT_SUPERSEDED: 'verdict_draft_superseded',
} as const satisfies Record<TransitionErrorCode, string>;

export type BatchSkipReason =
  | 'forbidden'
  | 'not_found'
  | (typeof BATCH_SKIP_BY_CODE)[TransitionErrorCode];
