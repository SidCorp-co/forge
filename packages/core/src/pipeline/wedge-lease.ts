/** What the autonomous wedge pass reads off a candidate's `session_context.lease`, and the comment a
 *  reset leaves. The pass decides "nothing is working this issue" from the job table; a run holding
 *  a live lease is working it whatever the job table says (ISS-1317). */

import { sql } from 'drizzle-orm';
import type { IssueDependencyExecutor } from '../issues/dependency-executor.js';
import { statusLabel } from '../issues/status-sets.js';
import { classifyLease, type LeaseReading, leaseIsWorkInProgress } from './session-claim.js';

/** Holder fanout is not counted: the question is whether THIS issue's claim is unexpired, and a
 *  holder claiming several issues is still working each one it holds. */
export function readWedgeLease(lease: unknown, now: Date): LeaseReading {
  return classifyLease({ lease, now, fanout: 1 });
}

export function wedgeLeaseHoldsTheIssue(reading: LeaseReading): boolean {
  return leaseIsWorkInProgress(reading.verdict);
}

/** The lease as committed now. A transition calls it after locking the row, so a renewal in flight
 *  commits first and is what this reads. */
export async function wedgeLeaseUnderLock(
  executor: IssueDependencyExecutor,
  issueId: string,
): Promise<unknown> {
  const rows = await executor.execute(
    sql`SELECT session_context -> 'lease' AS lease FROM issues WHERE id = ${issueId}::uuid`,
  );
  return (rows[0] as { lease?: unknown } | undefined)?.lease ?? null;
}

function seconds(ms: number | null): string {
  const n = Math.round((ms ?? 0) / 1000);
  return `${n} second${n === 1 ? '' : 's'}`;
}

const AT = new Intl.DateTimeFormat('en-GB', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'UTC',
});

/** A moment as a person reads it, in UTC: never an ISO stamp (ISS-1229 r16). */
function when(at: Date | null | undefined): string {
  return at ? `${AT.format(at)} UTC` : 'a time that could not be read';
}

/** Why no claim kept the issue, in plain words: no backticked id, stored verdict or ISO stamp. */
function leaseSentence(reading: LeaseReading): string {
  const held =
    reading.holder === null ? 'the claim on it' : `the claim ${reading.holder} held on it`;
  switch (reading.verdict) {
    case 'none':
      return 'no agent held a claim on it';
    case 'expired':
      return reading.stopped
        ? `${held} had been given back`
        : `${held} ran out at ${when(reading.expiresAt)}`;
    case 'abandoned':
      return `${held} runs until ${when(reading.expiresAt)}, but its holder's heartbeat has been silent for ${seconds(reading.silentMs)}, past the ${seconds(reading.toleranceMs)} it is allowed`;
    case 'malformed':
      return 'the claim on it could not be read, so it holds nothing';
    default:
      return `${held} could not be judged, so it holds nothing`;
  }
}

export function buildWedgeResetBody(args: {
  from: string;
  to: string;
  grace: string;
  reading: LeaseReading;
}): string {
  return [
    `**Moved by the reconciler: ${statusLabel(args.from)} -> ${statusLabel(args.to)}**`,
    '',
    `Forge's check for stalled issues made this move, not a person. It found nothing working the issue: the agent that last worked on it has stopped, no work is queued or running, nothing wrote to the issue for ${args.grace}, and ${leaseSentence(args.reading)}.`,
    '',
    `The issue is back at ${statusLabel(args.to)}, where the next agent to look for work takes it up again.`,
  ].join('\n');
}
