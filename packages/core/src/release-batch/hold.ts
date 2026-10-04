/**
 * ISS-1215 — why the automatic release is not taking an issue, kept as a record on the issue.
 *
 * Where production deploys `on-land`, `awaiting_release` is a transit state that
 * `release-batch/release-sweep.ts` moves a row out of, so every way that sweep declines a row is a
 * `release_holds` row: a held issue must not read like one nobody looked at. This module is the
 * table's one writer.
 */

import type { ReleaseHoldOwer, ReleaseHoldView } from '@forge/contracts/releases';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { releaseHolds } from '../db/schema-release-ledger.js';
import { sqlTimestamp } from '../db/sql-timestamp.js';
import type { IssueCriteriaReport } from '../issues/criteria-verdicts.js';
import { logger } from '../observability/logger.js';
import { type ServingReading, servingClause } from './serving-reading.js';

/** What holds a row back, as the sweep decided it. */
export interface ReleaseHold {
  /** The code an operator already knows the reason under, or one of this module's own. */
  readonly code: string;
  readonly reason: string;
  readonly owes: ReleaseHoldOwer;
  readonly waitingFor: string;
}

/**
 * The same reason with the moment a probe was read taken out of it. The host and the commit are
 * what the hold SAYS; the clock value beside them moves every tick while the answer stands still,
 * and a reason compared with it would be a new hold every minute for as long as a row is held.
 * So a stored reason keeps the timestamp of the reading that wrote it (ISS-1215, ISS-1286).
 */
export function withoutReadingTimes(text: string): string {
  return text.replace(/read at \d{4}-\d{2}-\d{2}T[\d:.]+Z/g, 'read at a moment');
}

/** A runner's reset time to the minute: its milliseconds move each heartbeat while the limit stands. */
export function withoutResetDrift(text: string): string {
  return text.replace(
    /(is rate limited|is quarantined) until (\d{4}-\d{2}-\d{2}T\d{2}:\d{2})[\d:.]*Z/g,
    '$1 until $2Z',
  );
}

function comparable(text: string): string {
  return withoutResetDrift(withoutReadingTimes(text));
}

/** Whether two holds say the same thing; `heldAt` is when it was written, never what it says. */
export function sameReleaseHold(a: ReleaseHold | null, b: ReleaseHold): boolean {
  return (
    a !== null &&
    a.code === b.code &&
    comparable(a.reason) === comparable(b.reason) &&
    a.owes === b.owes &&
    a.waitingFor === b.waitingFor
  );
}

function criteriaNamed(numbers: readonly number[]): string {
  if (numbers.length === 1) return `criterion ${numbers[0]}`;
  return `each of criteria ${numbers.slice(0, -1).join(', ')} and ${numbers.at(-1)}`;
}

/** One clause per distinct reason, carrying every criterion it holds, in first-criterion order. */
function reasonsByWhy(report: IssueCriteriaReport): string {
  const byWhy = new Map<string, number[]>();
  for (const c of report.unearned) byWhy.set(c.why, [...(byWhy.get(c.why) ?? []), c.criterion]);
  return [...byWhy].map(([why, numbers]) => `${criteriaNamed(numbers)}: ${why}`).join('; ');
}

/** Where a verdict has to be judged to count — the one place the reading is said (ISS-1346). */
function judgeClause(serving: ServingReading): string {
  if (serving.kind === 'serving') {
    return (
      'record a verdict on each criterion named, judged at a commit this project is serving — ' +
      servingClause(serving)
    );
  }
  if (serving.kind === 'unreadable') {
    const asked = serving.hosts.length === 0 ? '' : ` (read from ${serving.hosts.join(', ')})`;
    return (
      `nothing could be read from what this project answers through${asked}, read at ` +
      `${serving.readAt}: ${serving.why}. Record a verdict on each criterion named — a verdict ` +
      'nothing could check still earns the criterion, and this sentence is why it reads as weaker'
    );
  }
  return (
    `nothing here can read what this project is serving: ${serving.missing}. To give it a way, ` +
    `${serving.route}, then record a verdict on each criterion named`
  );
}

/**
 * Owed by a person: nothing dispatched claims a row at `awaiting_release`, and the release that
 * would is the one holding it, so every act that moves the row from here is somebody's by hand.
 */
export function criteriaHold(report: IssueCriteriaReport): ReleaseHold {
  const reasons = reasonsByWhy(report);
  const judge = judgeClause(report.serving);
  return {
    code: 'RELEASE_CRITERIA_UNEARNED',
    reason:
      `The automatic release carries only an issue whose every acceptance criterion is earned, and ` +
      `this one is not — ${reasons}. A person clears this: ${judge}; or, having seen ` +
      'the change running in production, close the issue by hand; or move it out of ' +
      '`awaiting_release` if it is not to ship.',
    owes: 'human',
    waitingFor:
      'a verdict on each criterion named at the running deployment, or the issue closed by hand',
  };
}

/**
 * The one reason every criteria-held row of a project with no runtime route shares (ISS-1346).
 * No run can clear it: nothing can read what the project serves, so no verdict a run writes can
 * be weighed. It is the project's to answer.
 */
export function runtimeUnroutedHold(missing: string, route: string): ReleaseHold {
  return {
    code: 'RELEASE_RUNTIME_UNROUTED',
    reason:
      `The automatic release carries only an issue whose every acceptance criterion is earned at ` +
      `what this project is serving, and nothing here can read what it is serving: ${missing}, ` +
      "and the production environment's runtime probes cannot say either. No verdict a run " +
      'records can be weighed until ' +
      `that changes, so this is the project's to answer and not this issue's: ${route}, and the ` +
      'next sweep weighs every waiting issue again.',
    owes: 'human',
    waitingFor: 'a way for this project to be read for what it is serving',
  };
}

export function targetUndeclaredHold(message: string): ReleaseHold {
  return {
    code: 'RELEASE_TARGET_UNDECLARED',
    reason: message,
    owes: 'human',
    waitingFor: 'a production environment with a deploy binding for the release to land on',
  };
}

export function gateUnreadableHold(message: string): ReleaseHold {
  return {
    code: 'RELEASE_GATE_UNREADABLE',
    reason:
      `The release gate for this project could not be read, so the automatic release did not ` +
      `decide anything about this issue: ${message}. Nothing was claimed or moved, and the next ` +
      'sweep reads the gate again.',
    owes: 'human',
    waitingFor: 'the release gate to be readable',
  };
}

export function criteriaUnreadableHold(message: string): ReleaseHold {
  return {
    code: 'RELEASE_CRITERIA_UNREADABLE',
    reason:
      `The verdicts on this issue could not be read, so the automatic release could not tell ` +
      `whether its criteria are earned: ${message}. Nothing was claimed or moved, and the next ` +
      'sweep reads them again.',
    owes: 'human',
    waitingFor: 'the verdicts to be readable',
  };
}

export function queuedBehindHold(carried: number): ReleaseHold {
  return {
    code: 'RELEASE_QUEUED_BEHIND',
    reason:
      `One release carries at most ${carried} issues, the oldest merges first, and this one is ` +
      'behind them. It was not sent this tick and goes in a later automatic release.',
    owes: 'agent',
    waitingFor: 'a later automatic release',
  };
}

export const NO_RELEASE_GATE_HOLD: ReleaseHold = {
  code: 'NO_RELEASE_GATE',
  reason:
    'This project declares no release (its project document has no production environment), so ' +
    'there is no release for the automatic sweep to carry this issue into, and nothing will move ' +
    'it from `awaiting_release`. Either declare a production environment with a deploy binding, ' +
    'or close the issue.',
  owes: 'human',
  waitingFor: 'a person to declare a release or close the issue',
};

export const NO_ACTOR_HOLD: ReleaseHold = {
  code: 'RELEASE_NO_ACTOR',
  reason:
    'This project has no owner for the automatic release to act as, so no release can be cut for ' +
    'this issue. Give the project an owner and the next sweep cuts it.',
  owes: 'human',
  waitingFor: 'an owner on the project',
};

// A refusal that clears itself (a release already running, a claim another writer won) is owed by
// the release path; every other one names a declaration or a fleet a person has to change.
const SELF_CLEARING: Readonly<Record<string, string>> = {
  BATCH_IN_FLIGHT: 'the release already in flight to finish',
  CLAIM_CONFLICT: 'the next sweep, after the claim another writer took is settled',
};

/**
 * A refusal's words without the heartbeat ages `runnerHoldClause` puts in them. An age moves every
 * tick while the refusal stands still, so kept in, it would read as a new reason each sweep and
 * replace the hold every minute of an outage; stored, it would be false a minute later.
 */
export function withoutAges(text: string): string {
  return text
    .replace(/ It is up and reporting, last seen \d+s ago\./g, ' It is up and reporting.')
    .replace(/ (?:It last reported|Last seen) \d+s ago\./g, '');
}

export function refusalHold(code: string, reasons: readonly string[]): ReleaseHold {
  const selfClearing = SELF_CLEARING[code];
  return {
    code,
    reason: withoutAges(`The automatic release was refused: ${reasons.join(' ')}`),
    owes: selfClearing ? 'agent' : 'human',
    waitingFor: selfClearing ?? 'the refusal named here to be cleared',
  };
}

export function cutFailedHold(reasons: readonly string[]): ReleaseHold {
  return {
    code: 'RELEASE_CUT_FAILED',
    reason:
      `An automatic release attempt failed: ${withoutAges(reasons.join(' '))} This issue is unchanged: not ` +
      'claimed, not moved, no half-release. The next sweep tries again on its own.',
    owes: 'human',
    waitingFor: 'the failure named here to be fixed',
  };
}

export interface ReleaseHoldTally {
  /** Rows whose hold was written or replaced this call. */
  written: number;
  /** Rows already carrying this exact hold. */
  unchanged: number;
  /** Rows that had left the gate between the read and the write. */
  skipped: number;
}

/**
 * Write one hold onto each row. A row already held for the same words keeps its record; a changed
 * reason clears the standing record and adds the new one in one transaction, guarded on the row
 * still waiting unclaimed at the gate, so a row a release took in between is left as it is.
 */
export async function writeReleaseHolds(args: {
  projectId: string;
  issueIds: readonly string[];
  holdFor: (issueId: string) => ReleaseHold;
  now: Date;
}): Promise<ReleaseHoldTally> {
  const tally: ReleaseHoldTally = { written: 0, unchanged: 0, skipped: 0 };
  if (args.issueIds.length === 0) return tally;
  const standing = await standingHolds(args.issueIds);
  for (const issueId of args.issueIds) {
    const hold = args.holdFor(issueId);
    if (sameReleaseHold(standing.get(issueId) ?? null, hold)) {
      tally.unchanged += 1;
      continue;
    }
    const wrote = await db.transaction(async (tx) => {
      const waiting = (await tx.execute(sql`
        SELECT 1 FROM issues
         WHERE id = ${issueId}
           AND status = 'awaiting_release'
           AND release_batch_run_id IS NULL
         FOR UPDATE
      `)) as unknown as unknown[];
      if (waiting.length === 0) return false;
      await tx
        .update(releaseHolds)
        .set({ clearedAt: args.now })
        .where(and(eq(releaseHolds.issueId, issueId), isNull(releaseHolds.clearedAt)));
      await tx.insert(releaseHolds).values({
        projectId: args.projectId,
        issueId,
        code: hold.code,
        reason: hold.reason,
        owes: hold.owes,
        waitingFor: hold.waitingFor,
        heldAt: args.now,
      });
      return true;
    });
    if (wrote) tally.written += 1;
    else tally.skipped += 1;
  }
  return tally;
}

async function standingHolds(issueIds: readonly string[]): Promise<Map<string, ReleaseHold>> {
  const rows = await db
    .select({
      issueId: releaseHolds.issueId,
      code: releaseHolds.code,
      reason: releaseHolds.reason,
      owes: releaseHolds.owes,
      waitingFor: releaseHolds.waitingFor,
    })
    .from(releaseHolds)
    .where(and(inArray(releaseHolds.issueId, [...issueIds]), isNull(releaseHolds.clearedAt)));
  return new Map(rows.map(({ issueId, ...hold }) => [issueId, hold]));
}

/** The hold standing on each of these issues, for the ones that have one. */
export async function readReleaseHolds(
  issueIds: readonly string[],
): Promise<Map<string, ReleaseHoldView>> {
  if (issueIds.length === 0) return new Map();
  const rows = await db
    .select({
      issueId: releaseHolds.issueId,
      code: releaseHolds.code,
      reason: releaseHolds.reason,
      owes: releaseHolds.owes,
      waitingFor: releaseHolds.waitingFor,
      heldAt: releaseHolds.heldAt,
    })
    .from(releaseHolds)
    .where(and(inArray(releaseHolds.issueId, [...issueIds]), isNull(releaseHolds.clearedAt)));
  return new Map(
    rows.map(({ issueId, heldAt, ...hold }) => [
      issueId,
      { ...hold, heldAt: heldAt.toISOString() },
    ]),
  );
}

/** Take the hold off these rows: a release claimed them, or nothing holds them any more. */
export async function clearReleaseHolds(
  issueIds: readonly string[],
  now: Date = new Date(),
): Promise<number> {
  if (issueIds.length === 0) return 0;
  const cleared = await db
    .update(releaseHolds)
    .set({ clearedAt: now })
    .where(and(inArray(releaseHolds.issueId, [...issueIds]), isNull(releaseHolds.clearedAt)))
    .returning({ id: releaseHolds.id });
  return cleared.length;
}

/** Take the hold off every row of a project the automatic release no longer covers. */
export async function clearProjectReleaseHolds(
  projectId: string,
  now: Date = new Date(),
): Promise<number> {
  const cleared = await db
    .update(releaseHolds)
    .set({ clearedAt: now })
    .where(and(eq(releaseHolds.projectId, projectId), isNull(releaseHolds.clearedAt)))
    .returning({ id: releaseHolds.id });
  return cleared.length;
}

/**
 * Take the hold off every row that is no longer waiting unclaimed at the gate, whichever route
 * took it there — a person's close, a release claim, a reopen. Without it the first hold a row is
 * given outlives the wait it describes.
 */
export async function clearStaleReleaseHolds(now: Date = new Date()): Promise<number> {
  const cleared = (await db.execute(sql`
    UPDATE release_holds h
       SET cleared_at = ${sqlTimestamp(now)}
      FROM issues i
     WHERE h.issue_id = i.id
       AND h.cleared_at IS NULL
       AND (i.status <> 'awaiting_release' OR i.release_batch_run_id IS NOT NULL)
    RETURNING h.id
  `)) as unknown as Array<{ id: string }>;
  if (cleared.length > 0) {
    logger.info({ cleared: cleared.length }, 'release-hold: holds cleared on rows that moved on');
  }
  return cleared.length;
}
