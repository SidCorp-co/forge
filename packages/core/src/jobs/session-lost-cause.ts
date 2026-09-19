/** Every field of a kill-gate config that describes the CAUSE. */
export type SessionLostCause = {
  error: string;
  failureKind: 'code' | 'infra' | 'timeout';
  failureReason: string;
  wedgeReason: string;
  confirmedWedgeAction: string;
};

const PARK_UNANSWERED = 'park_unanswered';

const LOST: SessionLostCause = {
  error: 'session_lost',
  failureKind: 'infra',
  failureReason: 'agent session terminated without job completion (silent runner/agent death)',
  wedgeReason: 'linked agent session terminated without the job reporting completion',
  confirmedWedgeAction:
    'The job was failed and routed to retry. If retries keep landing here, inspect the device runner logs for silent deaths.',
};

const PARKED: SessionLostCause = {
  error: PARK_UNANSWERED,
  failureKind: 'code',
  failureReason: 'the question this job parked on went unanswered past its deadline',
  wedgeReason: 'the job parked on a question and nobody answered it before its deadline',
  confirmedWedgeAction:
    'NO retry was scheduled, deliberately: the question is still unanswered, so a retry would put a second agent on it guessing. Answer the question on the issue and re-run it, or close the issue.',
};

/**
 * The cause to write on a job whose session ended for `failureReason`.
 */
export function sessionLostCause(failureReason: string | null): SessionLostCause {
  return failureReason === PARK_UNANSWERED ? PARKED : LOST;
}
