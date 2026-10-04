/** ISS-1273 — who is working one issue, on whichever of the three lanes opened the work: the job
 *  lane's `agent_sessions.metadata.issueId`, the run-session lane's `issue_leases` row, and
 *  `issue_work_state.lease`. `none` carries its reason: an absent field reads as quiet. */

import { type LeaseReading, type LeaseVerdict, leaseIsWorkInProgress } from './session-claim.js';

/** The session lanes, richer record first — the order a reader prefers them in. */
export const SESSION_WORKER_LANES = ['job', 'run_session'] as const;
export type SessionWorkerLane = (typeof SESSION_WORKER_LANES)[number];

export interface WorkerSession {
  id: string;
  status: string;
  lane: SessionWorkerLane;
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

function liveSession(session: WorkerSession): boolean {
  return session.status === 'queued' || session.status === 'running';
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

/** Why no lane answered. What is absent is a LIVE session, and the clause names their statuses
 *  rather than judging them: `idle` is neither live nor terminal. It may not end at a bare colon
 *  either — `session-claim.ts` leaves `detail` empty for every verdict but `malformed`. */
function absenceOf(claim: LeaseReading | null, sessions: readonly WorkerSession[]): string {
  return `${sessionClause(sessions)}, and ${claimClause(claim)}`;
}

function sessionClause(sessions: readonly WorkerSession[]): string {
  if (sessions.length === 0) {
    return 'no agent session is bound to this issue on either session lane';
  }
  const lanes = [...new Set(sessions.map((s) => s.lane))].sort().join(' and ');
  const statuses = [...new Set(sessions.map((s) => s.status))].sort().join(', ');
  const n = sessions.length;
  return `none of the ${n} agent session${n === 1 ? '' : 's'} bound to this issue on the ${lanes} lane is queued or running (${statuses})`;
}

function claimClause(claim: LeaseReading | null): string {
  if (claim === null || claim.verdict === 'none') return 'its record carries no claim';
  const holder = claim.holder === null ? 'an unnamed holder' : claim.holder;
  const why = claim.detail === '' ? '' : `: ${claim.detail}`;
  return `the claim by ${holder} reads ${claim.verdict}${why}`;
}
