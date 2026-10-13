/** ISS-1273 — who is working one issue, on whichever of the three lanes opened the work: the job
 *  lane's `agent_sessions.metadata.issueId`, the run-session lane's `issue_leases` row, and
 *  `issues.session_context.lease`. `none` carries its reason: an absent field reads as quiet.
 *
 *  ISS-1320 — a session is HELD or merely OPENED OVER the issue. The lease row says who holds it
 *  now and is gone once a run gives the issue back; the run's recorded group says who was ever
 *  opened over it. Only a holder is a worker, and the absence sentence counts the opened-over. */

import {
  type LeaseReading,
  type LeaseVerdict,
  leaseIsWorkInProgress,
} from '../pipeline/session-claim.js';

/** The session lanes, richer record first — the order a reader prefers them in. */
export const SESSION_WORKER_LANES = ['job', 'run_session'] as const;
export type SessionWorkerLane = (typeof SESSION_WORKER_LANES)[number];

export interface WorkerSession {
  id: string;
  status: string;
  lane: SessionWorkerLane;
  /** True for a job-lane session, which carries its one issue, and for a run session whose
   *  `issue_leases` row for the issue still exists. False for a run session that was opened over
   *  the issue and has since given it back: it may be running, on another issue of its group. */
  holds: boolean;
}

export type IssueWorker =
  | { lane: SessionWorkerLane; sessionId: string; sessionStatus: 'queued' | 'running' }
  | {
      lane: 'claim';
      holder: string;
      verdict: LeaseVerdict;
      expiresAt: string | null;
      silentMs: number | null;
    }
  | { lane: 'none'; detail: string }
  | { lane: 'unreadable'; detail: string };

/** ISS-1273 — what a caller answers with when the derivation failed: the answer is missing,
 *  which is a different thing from nobody working the issue. */
export function unreadableWorker(detail: string): IssueWorker {
  return { lane: 'unreadable', detail };
}

/** A session working THIS issue: live, and holding it. */
export function liveSession(session: Pick<WorkerSession, 'status' | 'holds'>): boolean {
  return session.holds && (session.status === 'queued' || session.status === 'running');
}

/** A session outranks a claim: core wrote that row itself and only classifies the claim. */
export function classifyIssueWorker(input: {
  sessions: readonly WorkerSession[];
  claim: LeaseReading | null;
}): IssueWorker {
  for (const lane of SESSION_WORKER_LANES) {
    const found = input.sessions.find((s) => s.lane === lane && liveSession(s));
    if (found) {
      return { lane, sessionId: found.id, sessionStatus: found.status as 'queued' | 'running' };
    }
  }

  const claim = input.claim;
  if (claim && claim.holder !== null && leaseIsWorkInProgress(claim.verdict)) {
    return {
      lane: 'claim',
      holder: claim.holder,
      verdict: claim.verdict,
      expiresAt: claim.expiresAt === null ? null : claim.expiresAt.toISOString(),
      silentMs: claim.silentMs,
    };
  }

  return { lane: 'none', detail: absenceOf(claim, input.sessions) };
}

/** Why no lane answered. What is absent is a LIVE HOLDING session, and the clause says what it
 *  counted and names those sessions' statuses rather than judging them: `idle` is neither live
 *  nor terminal. It may not end at a bare colon either — `session-claim.ts` leaves `detail` empty
 *  for every verdict but `malformed`. */
function absenceOf(claim: LeaseReading | null, sessions: readonly WorkerSession[]): string {
  return `${sessionClause(sessions)}, and ${claimClause(claim)}`;
}

function sessionClause(sessions: readonly WorkerSession[]): string {
  if (sessions.length === 0) {
    return 'no agent session is on record as opened over this issue on either session lane';
  }
  const lanes = [...new Set(sessions.map((s) => s.lane))].sort().join(' and ');
  const statuses = [...new Set(sessions.map((s) => s.status))].sort().join(', ');
  const n = sessions.length;
  return `none of the ${n} agent session${n === 1 ? '' : 's'} on record as opened over this issue on the ${lanes} lane is queued or running and holding it (${statuses})`;
}

function claimClause(claim: LeaseReading | null): string {
  if (claim === null || claim.verdict === 'none') return 'its record carries no claim';
  const holder = claim.holder === null ? 'an unnamed holder' : claim.holder;
  const why = claim.detail === '' ? '' : `: ${claim.detail}`;
  return `the claim by ${holder} reads ${claim.verdict}${why}`;
}
