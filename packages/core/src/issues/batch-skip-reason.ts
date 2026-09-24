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
  ENTRY_CRITERIA_UNMET: 'entry_criteria_unmet',
  ISSUE_ARCHIVED: 'issue_archived',
} as const satisfies Record<TransitionErrorCode, string>;

export type BatchSkipReason =
  | 'forbidden'
  | 'not_found'
  | (typeof BATCH_SKIP_BY_CODE)[TransitionErrorCode];
