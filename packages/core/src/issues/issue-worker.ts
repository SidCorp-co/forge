/**
 * ISS-1273 — who is working one issue, on whichever of the three lanes opened the work: the job
 * lane's `agent_sessions.metadata.issueId`, the run-session lane's `issue_leases` row
 * (`devices/run-session.ts` opens one run over a GROUP, so its session names no issue), and the
 * claim lane's `issues.session_context.lease`, which is all a driver leaves. `none` is an answer
 * here and carries its reason, because an absent field reads as a quiet system.
 */

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
  | { lane: 'none'; detail: string };

function liveSession(session: WorkerSession): boolean {
  return session.status === 'queued' || session.status === 'running';
}

/** A session outranks a claim: core wrote the session row itself, where the claim is a blob a
 *  driver wrote into the issue and core only classifies. */
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

  return { lane: 'none', detail: absenceOf(claim) };
}

function absenceOf(claim: LeaseReading | null): string {
  if (claim === null || claim.verdict === 'none') {
    return 'no agent session is bound to this issue on either session lane, and its record carries no claim';
  }
  const holder = claim.holder === null ? 'an unnamed holder' : claim.holder;
  return `no agent session is bound to this issue on either session lane, and the claim by ${holder} reads ${claim.verdict}: ${claim.detail}`;
}
