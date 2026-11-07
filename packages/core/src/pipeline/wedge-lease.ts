/** What the wedge net reads off a candidate's lease (`issue_work_state.lease`), and the notice it
 *  leaves on the `in_progress` work it finds nothing holding: landed work (ISS-564), or work that did
 *  not land, which it leaves where it stands for its master (ISS-1104). The net decides "nothing is
 *  working this issue" from the job table; a run holding a live lease is working it whatever the job
 *  table says (ISS-1317). */

import { sql } from 'drizzle-orm';
import type { IssueDependencyExecutor } from '../issues/index.js';
import { classifyLease, type LeaseReading, leaseIsWorkInProgress } from '../issues/index.js';
import type { LandedWork } from './wedge-landed.js';

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
  const session = reading.session === null ? '' : ` session \`${reading.session}\``;
  const held =
    reading.holder === null ? 'the lease' : `the lease held by \`${reading.holder}\`${session}`;
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

const LEFT_UNHELD_HEADING = '**Left at `in_progress` by the reconciler: nothing holds it**';

/**
 * What makes the unheld notice once per stretch at `in_progress`: its heading and when the issue
 * entered the status (`wedge-owed.ts:inProgressSinceSql`), which a pass over the same stretch writes
 * the same and a new claim writes anew. Nothing read off the lease is in it.
 */
export function wedgeLeftUnheldMarker(since: Date): string {
  return `${LEFT_UNHELD_HEADING}\n\nIt has stood at \`in_progress\` since ${since.toISOString()}.`;
}

/** The notice on unlanded work the net finds nothing holding, opening on its marker. */
export function buildWedgeLeftUnheldBody(args: {
  grace: string;
  reading: LeaseReading;
  since: Date;
}): string {
  return [
    `${wedgeLeftUnheldMarker(args.since)} Nothing has written to it for ${args.grace}, no job or run is live on it, and ${leaseSentence(args.reading)}; no status was moved.`,
    '',
    'Its master is woken to decide: hand it back for the next dispatch (a `recovery: true` move to `open` with the reason), hold it (`on_hold` with the reason and what ends the hold), or claim it and carry it on.',
  ].join('\n');
}

const LEFT_LANDED_HEADING = '**Left at `in_progress` by the reconciler: its work landed**';

function markSentence(landed: LandedWork): string {
  const where = landed.commit
    ? `commit \`${landed.commit}\``
    : landed.landing
      ? `landing \`${landed.landing}\``
      : 'a mark naming no commit';
  return `Its merge is recorded: ${where}, marked at ${landed.mergedAt.toISOString()}.`;
}

/**
 * What makes the notice once per mark: its heading and the mark, which a pass over the same mark
 * writes the same and a new mark (a new commit or a new time) writes anew. Nothing a pass reads off
 * the lease is in it, since a silent heartbeat's seconds differ every pass (ISS-564 round 2).
 */
export function wedgeLeftLandedMarker(landed: LandedWork): string {
  return `${LEFT_LANDED_HEADING}\n\n${markSentence(landed)}`;
}

/** The notice on landed work the pass leaves, opening on its {@link wedgeLeftLandedMarker}. */
export function buildWedgeLeftLandedBody(args: {
  grace: string;
  reading: LeaseReading;
  landed: LandedWork;
}): string {
  return [
    `${wedgeLeftLandedMarker(args.landed)} Landed work is not handed back to be dispatched again.`,
    '',
    `Nothing has written to this issue for ${args.grace}, and ${leaseSentence(args.reading)}.`,
    '',
    'Its master is woken to move it to `awaiting_release`. If this mark is not this work, clear it with `DELETE /api/issues/:id/merge`; the next pass then tells it as unheld work for its master to decide on.',
  ].join('\n');
}
