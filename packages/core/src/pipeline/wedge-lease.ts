/** What the autonomous wedge pass reads off a candidate's lease (`issue_work_state.lease`), and the comment a
 *  reset leaves. The pass decides "nothing is working this issue" from the job table; a run holding
 *  a live lease is working it whatever the job table says (ISS-1317). */

import { sql } from 'drizzle-orm';
import type { IssueDependencyExecutor } from '../issues/index.js';
import { classifyLease, type LeaseReading, leaseIsWorkInProgress } from '../issues/index.js';

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
    sql`SELECT lease FROM issue_work_state WHERE issue_id = ${issueId}::uuid`,
  );
  return (rows[0] as { lease?: unknown } | undefined)?.lease ?? null;
}

function seconds(ms: number | null): string {
  return `${Math.round((ms ?? 0) / 1000)}s`;
}

function leaseSentence(reading: LeaseReading): string {
  const held = reading.holder === null ? 'the lease' : `the lease held by \`${reading.holder}\``;
  switch (reading.verdict) {
    case 'none':
      return 'no run held a lease on it';
    case 'expired':
      return reading.stopped
        ? `${held} had been given back`
        : `${held} lapsed at ${reading.expiresAt?.toISOString() ?? 'an unreadable time'}`;
    case 'abandoned':
      return `${held} runs until ${reading.expiresAt?.toISOString() ?? 'an unreadable time'}, but its holder's heartbeat has been silent for ${seconds(reading.silentMs)}, past the ${seconds(reading.toleranceMs)} it tolerates`;
    case 'malformed':
      return `the lease could not be read (${reading.detail}), so it holds nothing`;
    default:
      return `${held} read as \`${reading.verdict}\``;
  }
}

export function buildWedgeResetBody(args: {
  from: string;
  to: string;
  grace: string;
  reading: LeaseReading;
}): string {
  return [
    `**Moved by the reconciler: \`${args.from}\` -> \`${args.to}\`**`,
    '',
    `The reconciler's autonomous wedge pass made this move, not a person. It found nothing working the issue: its latest job is a \`drive\` job that is no longer live, no job is queued or running, nothing wrote to the issue for ${args.grace}, and ${leaseSentence(args.reading)}.`,
    '',
    `The issue is back at \`${args.to}\`, where the next dispatch takes it up again.`,
  ].join('\n');
}
