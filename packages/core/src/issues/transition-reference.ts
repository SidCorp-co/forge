import { z } from 'zod';
import { describeOperation, fail, json } from '../api-reference/describe.js';
import { issueStatuses, waitingKinds } from '../db/schema.js';
import type { TransitionErrorCode } from './apply-transition.js';

/**
 * The status each refusal of the state machine is answered at. Exhaustive over
 * `TransitionErrorCode`, so a code added there fails to compile until it has a status here, and
 * the route's reference is read from the same table the route answers from.
 */
export const TRANSITION_REFUSAL_STATUS = {
  NO_OP: 409,
  ILLEGAL_TRANSITION: 409,
  STALE_TRANSITION: 409,
  NO_WORK_EVIDENCE: 409,
  ISSUE_ARCHIVED: 409,
  OPEN_QUESTIONS: 409,
  TRANSITION_REASON_REQUIRED: 422,
  WAITING_KIND_REQUIRED: 422,
  WAITING_KIND_NOT_APPLICABLE: 422,
  RELEASE_RECORD_REQUIRED: 422,
  CLOSE_REQUIRES_SHIPPED: 422,
  CLOSE_REQUIRES_RELEASE_TAG: 422,
  RELEASE_TARGET_UNDECLARED: 409,
  RELEASE_TAG_UNREAD: 503,
  ENTRY_CRITERIA_UNMET: 422,
  VOID_REASON_REQUIRED: 422,
} as const satisfies Record<TransitionErrorCode, 409 | 422 | 503>;

/** Where a rule stored a status other than the one asked for, and why. */
export const rewrittenSchema = z.object({
  requested: z.enum(issueStatuses),
  stored: z.enum(issueStatuses),
  rule: z.enum(['autonomous_driver', 'release_gate']),
  waitingKind: z.object({
    sent: z.enum(waitingKinds).nullable(),
    stored: z.enum(waitingKinds).nullable(),
  }),
  detail: z.string(),
});

export const transitionResultSchema = z.object({
  id: z.string(),
  status: z.enum(issueStatuses),
  reopenCount: z.number(),
  transitionedAt: z.date(),
  rewritten: rewrittenSchema.nullable(),
  warnings: z.array(z.string()).optional(),
});

const REFUSALS: Record<TransitionErrorCode, string> = {
  NO_OP: 'the issue already stands at the status, or a rule would store the status it already has',
  ILLEGAL_TRANSITION:
    'the move is not one this status allows, or `draft` was asked for by an issue that has run',
  STALE_TRANSITION: 'the status changed while the move was being applied',
  NO_WORK_EVIDENCE: 'the move needs evidence of work that the issue does not hold',
  ISSUE_ARCHIVED: 'the issue is archived',
  OPEN_QUESTIONS: 'a question on the issue is open and the move does not say what to do with it',
  TRANSITION_REASON_REQUIRED: 'a move that needs `reason` came without one',
  WAITING_KIND_REQUIRED: 'a move to `waiting` came without `waitingKind`',
  WAITING_KIND_NOT_APPLICABLE: '`waitingKind` was sent with a status other than `waiting`',
  RELEASE_RECORD_REQUIRED: 'the close needs a release record that was not made',
  CLOSE_REQUIRES_SHIPPED: 'the close needs the work marked as shipped first',
  CLOSE_REQUIRES_RELEASE_TAG:
    'the project ships by version tag and no matching tag contains the commit the issue landed as',
  RELEASE_TARGET_UNDECLARED:
    "the project's release chain names branches but has no active live deploy binding",
  RELEASE_TAG_UNREAD: "the repository's tags could not be read, so the close could not be checked",
  ENTRY_CRITERIA_UNMET: "the project's entry criteria for the status are not met",
  VOID_REASON_REQUIRED:
    '`voidQuestions` was needed to settle the open questions and came without a reason',
};

const refusalsAt = (status: 409 | 422 | 503) =>
  fail(
    Object.fromEntries(
      (Object.keys(REFUSALS) as TransitionErrorCode[])
        .filter((code) => TRANSITION_REFUSAL_STATUS[code] === status)
        .map((code) => [code, REFUSALS[code]]),
    ),
  );

export const transitionIssue = describeOperation({
  summary: "Move an issue to another status through the pipeline's state machine",
  description:
    'A rule may store a status other than the one asked for; `rewritten` then says which and why.',
  responses: {
    200: json(transitionResultSchema),
    403: fail('FORBIDDEN', 'the caller is not a project member with write access'),
    404: fail('NOT_FOUND', 'the issue does not exist'),
    409: refusalsAt(409),
    422: refusalsAt(422),
    503: refusalsAt(503),
  },
});
