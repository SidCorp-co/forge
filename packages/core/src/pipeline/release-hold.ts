/**
 * ISS-1215 — why the automatic release is not taking an issue, written on the issue.
 *
 * On an `autoProdDeploy` project `awaiting_release` is a transit state that `release-sweep.ts`
 * moves a row out of, so every way that sweep declines a row is written here rather than logged
 * alone: a held row must not read like one nobody looked at. This module is the one writer of
 * `session_context.releaseHold`, its comment, and the clearers that take it off a row.
 */

import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { comments, issues } from '../db/schema.js';
import type { IssueCriteriaReport } from '../issues/criteria-verdicts.js';
import { logger } from '../logger.js';
import type { ServingReading } from '../release-batch/serving-reading.js';

/** The session_context key this module owns. */
export const RELEASE_HOLD_KEY = 'releaseHold';

export type ReleaseHoldOwner = 'agent' | 'human';

/** What holds a row back, as the sweep decided it. */
export interface ReleaseHold {
  /** The code an operator already knows the reason under, or one of this module's own. */
  readonly code: string;
  readonly reason: string;
  readonly owes: ReleaseHoldOwner;
  readonly waitingFor: string;
}

/** The hold as it is stored on the row. */
export interface StoredReleaseHold extends ReleaseHold {
  readonly at: string;
  readonly status: 'awaiting_release';
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/** The hold a row carries, or null where it carries none or one this build cannot read. */
export function readReleaseHold(value: unknown): ReleaseHold | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const code = text(v.code);
  const reason = text(v.reason);
  const waitingFor = text(v.waitingFor);
  const owes = v.owes === 'agent' || v.owes === 'human' ? v.owes : null;
  if (!code || !reason || !waitingFor || !owes) return null;
  return { code, reason, owes, waitingFor };
}

/**
 * The same reason with the moment a probe was read taken out of it. The host and the commit are
 * what the hold SAYS; the clock value beside them moves every tick while the answer stands still,
 * and a rewritten hold is a re-commented hold — a comment a minute for as long as a row is held.
 * So a stored reason keeps the timestamp of the reading that wrote it (ISS-1215, ISS-1286).
 */
export function withoutReadingTimes(text: string): string {
  return text.replace(/read at \d{4}-\d{2}-\d{2}T[\d:.]+Z/g, 'read at a moment');
}

/** Whether two holds say the same thing; `at` is when it was written, never what it says. */
export function sameReleaseHold(a: ReleaseHold | null, b: ReleaseHold): boolean {
  return (
    a !== null &&
    a.code === b.code &&
    withoutReadingTimes(a.reason) === withoutReadingTimes(b.reason) &&
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

/** Where a verdict has to be judged for it to count, said from the reading rather than from a field. */
function judgeClause(serving: ServingReading): string {
  const asked = serving.kind === 'undeclared' ? '' : ` (asked at ${serving.hosts.join(', ')})`;
  if (serving.kind === 'serving') {
    const rollout = serving.commits.length > 1 ? ' — a rollout that has not finished' : '';
    const unread = serving.unread.length === 0 ? '' : ` ${serving.unread.join('; ')}.`;
    return (
      `record a verdict on each criterion named, judged at what this project is serving${asked}, ` +
      `\`${serving.commits.join('` and `')}\`${rollout}, read at ${serving.readAt}.${unread}`
    );
  }
  if (serving.kind === 'unreadable') {
    return (
      `nothing could be read from the probes this project declares${asked}, read at ` +
      `${serving.readAt}: ${serving.why}. Record a verdict on each criterion named — a verdict ` +
      'nothing could check still earns the criterion, and this sentence is why it reads as weaker'
    );
  }
  return (
    'this project declares no way to ask a host what it is serving, so no runtime verdict can be ' +
    'checked here: declare a commit endpoint on the live deploy binding under `verify.probes`, or ' +
    'on the project under `environments.live.commitUrl`, then record a verdict on each criterion named'
  );
}

/**
 * Owed by a person: nothing dispatched claims a row at `awaiting_release`, and the release that
 * would is the one holding it, so every act that moves the row from here is somebody's by hand.
 */
export function criteriaHold(report: IssueCriteriaReport): ReleaseHold {
  const judge = judgeClause(report.serving);
  return {
    code: 'RELEASE_CRITERIA_UNEARNED',
    reason:
      `The automatic release carries only an issue whose every acceptance criterion is earned, and ` +
      `this one is not — ${reasonsByWhy(report)}. A person clears this: ${judge}; or, having seen ` +
      'the change running in production, close the issue by hand; or move it out of ' +
      '`awaiting_release` if it is not to ship.',
    owes: 'human',
    waitingFor:
      'a verdict on each criterion named at the running deployment, or the issue closed by hand',
  };
}

export function targetUndeclaredHold(message: string): ReleaseHold {
  return {
    code: 'RELEASE_TARGET_UNDECLARED',
    reason: message,
    owes: 'human',
    waitingFor: 'a live deploy binding for the release to land on',
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
    'This project declares no release (its `releaseChain` is empty), so there is no release for ' +
    'the automatic sweep to carry this issue into, and nothing will move it from ' +
    '`awaiting_release`. Either declare a release chain with a live deploy binding, or close the ' +
    'issue.',
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
 * comment every minute of an outage; stored, it would be false a minute later.
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

export function releaseHoldComment(hold: ReleaseHold): string {
  const who = hold.owes === 'human' ? 'a person' : 'an agent run';
  return [
    '**The automatic release is holding this issue at `awaiting_release`.**',
    '',
    hold.reason,
    '',
    `It is waiting for ${hold.waitingFor}, which ${who} owes. The same reason is on the issue ` +
      'itself, under `releaseHold`, and is removed once it no longer holds.',
    '',
    `\`release-hold: ${hold.code}\``,
  ].join('\n');
}

export interface ReleaseHoldTally {
  /** Rows whose hold was written or replaced this call. */
  written: number;
  /** Rows already carrying this exact hold. */
  unchanged: number;
  /** Rows that had left the gate, or whose hold another writer moved, between read and write. */
  skipped: number;
}

/**
 * Write one hold onto each row, with one comment where the hold changed.
 *
 * The hold and its comment commit together, so a failed insert leaves the old hold and the next
 * sweep tries both again, rather than a stored hold whose comment nobody posted. The update is
 * guarded on the hold the read saw, so of two writers racing from one prior hold only one writes
 * and only that one comments, and on the row still waiting unclaimed, so a row a release took in
 * between is left as it is. `updated_at` is left alone: a held row must not read as freshly worked,
 * and the sweep's own cursor walks on it.
 */
export async function writeReleaseHolds(args: {
  issueIds: readonly string[];
  holdFor: (issueId: string) => ReleaseHold;
  authorId: string | null;
  now: Date;
}): Promise<ReleaseHoldTally> {
  const tally: ReleaseHoldTally = { written: 0, unchanged: 0, skipped: 0 };
  if (args.issueIds.length === 0) return tally;
  const rows = (await db
    .select({ id: issues.id, held: sql<unknown>`${issues.sessionContext} -> ${RELEASE_HOLD_KEY}` })
    .from(issues)
    .where(inArray(issues.id, [...args.issueIds]))) as Array<{ id: string; held: unknown }>;

  for (const row of rows) {
    const hold = args.holdFor(row.id);
    if (sameReleaseHold(readReleaseHold(row.held), hold)) {
      tally.unchanged += 1;
      continue;
    }
    const stored: StoredReleaseHold = {
      at: args.now.toISOString(),
      status: 'awaiting_release',
      ...hold,
    };
    const read = row.held === null || row.held === undefined ? null : JSON.stringify(row.held);
    const wrote = await db.transaction(async (tx) => {
      const updated = (await tx.execute(sql`
        UPDATE issues i
           SET session_context = jsonb_set(coalesce(i.session_context, '{}'::jsonb),
                                           ${`{${RELEASE_HOLD_KEY}}`}::text[],
                                           ${JSON.stringify(stored)}::jsonb, true)
         WHERE i.id = ${row.id}
           AND i.status = 'awaiting_release'
           AND i.release_batch_run_id IS NULL
           AND coalesce(i.session_context -> ${RELEASE_HOLD_KEY}, 'null'::jsonb)
               IS NOT DISTINCT FROM coalesce(${read}::jsonb, 'null'::jsonb)
        RETURNING i.id
      `)) as unknown as Array<{ id: string }>;
      if (updated.length === 0) return false;
      if (args.authorId) {
        await tx
          .insert(comments)
          .values({ issueId: row.id, authorId: args.authorId, body: releaseHoldComment(hold) });
      }
      return true;
    });
    if (wrote) tally.written += 1;
    else tally.skipped += 1;
  }
  return tally;
}

/** Take the hold off these rows: a release claimed them, or nothing holds them any more. */
export async function clearReleaseHolds(issueIds: readonly string[]): Promise<number> {
  if (issueIds.length === 0) return 0;
  const cleared = await db
    .update(issues)
    .set({ sessionContext: sql`${issues.sessionContext} - ${RELEASE_HOLD_KEY}` })
    .where(
      and(inArray(issues.id, [...issueIds]), sql`${issues.sessionContext} ? ${RELEASE_HOLD_KEY}`),
    )
    .returning({ id: issues.id });
  return cleared.length;
}

/** Take the hold off every waiting row of a project the automatic release no longer covers. */
export async function clearProjectReleaseHolds(projectId: string): Promise<number> {
  const cleared = await db
    .update(issues)
    .set({ sessionContext: sql`${issues.sessionContext} - ${RELEASE_HOLD_KEY}` })
    .where(
      and(eq(issues.projectId, projectId), sql`${issues.sessionContext} ? ${RELEASE_HOLD_KEY}`),
    )
    .returning({ id: issues.id });
  return cleared.length;
}

/**
 * Take the hold off every row that is no longer waiting unclaimed at the gate, whichever route
 * took it there — a person's close, a release claim, a reopen. Without it the first hold a row is
 * given outlives the wait it describes.
 */
export async function clearStaleReleaseHolds(): Promise<number> {
  const cleared = (await db.execute(sql`
    UPDATE issues i
       SET session_context = i.session_context - ${RELEASE_HOLD_KEY}
     WHERE i.session_context ? ${RELEASE_HOLD_KEY}
       AND (i.status <> 'awaiting_release' OR i.release_batch_run_id IS NOT NULL)
    RETURNING i.id
  `)) as unknown as Array<{ id: string }>;
  if (cleared.length > 0) {
    logger.info({ cleared: cleared.length }, 'release-hold: holds cleared on rows that moved on');
  }
  return cleared.length;
}
