// Which cause a job inherits when the session it belonged to went terminal.
//
// The session-lost hop frees a job whose session died, and it wrote ONE cause
// for every way that can happen: `session_lost` / `infra`. That is right for a
// silent runner death and wrong for a park nobody answered — `infra` derives
// the `retry` action, so closing the park would dispatch a fresh agent onto an
// issue whose question is still unanswered, which is criterion 26's own failure
// reached through the other door (ISS-964 criteria 26, 34).
//
// The session's own `failure_reason` is the discriminator, because the row that
// diagnosed the death is the row that already named it.

/** Every field of a kill-gate config that describes the CAUSE. */
export type SessionLostCause = {
  error: string;
  failureKind: 'code' | 'infra' | 'timeout';
  failureReason: string;
  wedgeReason: string;
  confirmedWedgeAction: string;
};

// cm:edge contract -> packages/core/src/jobs/agent-session-link.ts — this string must be a member of `SYNTHETIC_REAP_ERRORS` there, or the lifecycle sync writes the JOB's cause back over the session's `park_unanswered` and the park's own diagnosis is erased (the ISS-877 shape measured on epodsystem 2026-09-05).
// cm:edge contract -> packages/core/src/jobs/park-deadline.ts — the same word `reapUnansweredParks` writes to `agent_sessions.failure_reason`; matched literally below, so a rename there silently restores the retry.
const PARK_UNANSWERED = 'park_unanswered';

const LOST: SessionLostCause = {
  error: 'session_lost',
  failureKind: 'infra',
  failureReason: 'agent session terminated without job completion (silent runner/agent death)',
  wedgeReason: 'linked agent session terminated without the job reporting completion',
  confirmedWedgeAction:
    'The job was failed and routed to retry. If retries keep landing here, inspect the device runner logs for silent deaths.',
};

// cm:guard `code` is chosen for its ACTION and not for its English: `deriveActionFromKind` (jobs/retry.ts) maps `code` to `terminal` and `infra` to `retry`, and a park closed because nobody answered must never be retried — the question is still unanswered, so the retry asks a second agent to guess. If that mapping ever moves, this member moves with it.
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
// cm:guard defaults to the LOST cause on anything it does not recognise, including NULL. A park is the narrow case and a silent death is the general one, so an unrecognised reason must keep the reading the hop has always had rather than inheriting the park's no-retry.
export function sessionLostCause(failureReason: string | null): SessionLostCause {
  return failureReason === PARK_UNANSWERED ? PARKED : LOST;
}
