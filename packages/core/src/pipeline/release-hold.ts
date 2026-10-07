/**
 * ISS-1215 — why the automatic release is not taking an issue, written on the issue.
 *
 * On an `autoProdDeploy` project `awaiting_release` is a transit state that `release-sweep.ts`
 * moves a row out of, so every way that sweep declines a row is written here rather than logged
 * alone: a held row must not read like one nobody looked at. This module is the one writer of
 * `session_context.releaseHold`, its comment, and the clearers that take it off a row.
 */

import { createHash } from 'node:crypto';
import { and, eq, inArray, like, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { comments, issues } from '../db/schema.js';
import type { IssueCriteriaReport } from '../issues/criteria-verdicts.js';
import { issueDisplayIds } from '../issues/display-ids.js';
import { logger } from '../logger.js';
import { type ServingReading, servingClause } from '../release-batch/serving-reading.js';
import type { RuntimeReading } from '../release-batch/weighing.js';

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
  /** The latest `SAID_LIMIT` reasons commented on this row since it was last held afresh, as
   *  `saidKey`s; it goes with the hold, so a row held again starts with nothing said (ISS-1346). */
  readonly said?: readonly string[];
}

const SAID_LIMIT = 20;

/** What a reason says, to compare by: a reading time or a reset drifting does not change it. */
export function saidKey(hold: ReleaseHold): string {
  const said = [hold.code, comparable(hold.reason), hold.owes, hold.waitingFor].join('\u0000');
  return createHash('sha256').update(said).digest('hex').slice(0, 16);
}

export function saidOf(value: unknown): string[] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return [];
  const said = (value as Record<string, unknown>).said;
  return Array.isArray(said) ? said.filter((k): k is string => typeof k === 'string') : [];
}

function withSaid(said: readonly string[], key: string): string[] {
  return [...said.filter((k) => k !== key), key].slice(-SAID_LIMIT);
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

/** Whether two holds say the same thing; `at` is when it was written, never what it says. */
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

/** What one declared runtime was read as running, for the judge clause (ISS-1368). */
function runtimeClause(runtime: RuntimeReading): string {
  const { serving } = runtime;
  const read =
    serving.kind === 'serving'
      ? servingClause(serving)
      : serving.kind === 'unreadable'
        ? `nothing could be read, read at ${serving.readAt}: ${serving.why}`
        : `nothing reports it: ${serving.missing}`;
  return `the \`${runtime.name}\` runtime, under ${runtime.paths.map((p) => `\`${p}\``).join(', ')}: ${read}`;
}

/** Where a verdict has to be judged to count — the one place the reading is said (ISS-1346). */
function judgeClause(serving: ServingReading, runtimes: readonly RuntimeReading[]): string {
  const deployment = deploymentClause(serving, runtimes);
  if (serving.kind === 'serving' || runtimes.length === 0) return deployment;
  // The allowance above is the deployment's: a declared runtime with nothing read still holds.
  return (
    `${deployment}. A criterion held in a declared runtime earns only at a build it is running — ` +
    runtimes.map(runtimeClause).join('; ')
  );
}

function deploymentClause(serving: ServingReading, runtimes: readonly RuntimeReading[]): string {
  if (serving.kind === 'serving' && runtimes.length > 0) {
    return (
      'record a verdict on each criterion named, judged at a commit the runtime it is held in is ' +
      `running — the deployment: ${servingClause(serving)}; ${runtimes.map(runtimeClause).join('; ')}`
    );
  }
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
  const judge = judgeClause(report.serving, report.runtimes);
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
 * be weighed. It is the project's to answer, and the sweep comments it on one row alone.
 */
export function runtimeUnroutedHold(missing: string, route: string): ReleaseHold {
  return {
    code: 'RELEASE_RUNTIME_UNROUTED',
    reason:
      `The automatic release carries only an issue whose every acceptance criterion is earned at ` +
      `what this project is serving, and nothing here can read what it is serving: ${missing}, ` +
      'and no live binding declares `verify.probes`. No verdict a run records can be weighed until ' +
      `that changes, so this is the project's to answer and not this issue's: ${route}, and the ` +
      'next sweep weighs every waiting issue again.',
    owes: 'human',
    waitingFor: 'a way for this project to be read for what it is serving',
  };
}

/** What the finish's close would refuse this row for, which the sweep reads before it cuts (ISS-1337). */
export function closeRefusedHold(
  shortfalls: ReadonlyArray<{ code: string; reason: string; clears: string }>,
): ReleaseHold {
  const said = shortfalls.map((s) => `${s.reason} (\`${s.code}\`). ${s.clears}`).join(' ');
  return {
    code: 'RELEASE_ISSUES_UNCLOSABLE',
    reason:
      'The automatic release leaves this issue off: its close would be refused when the release ' +
      `finishes, so releasing it would only hand it back here. ${said} The next sweep carries it ` +
      'once that is cleared.',
    owes: shortfalls.some((s) => s.code === 'OPEN_QUESTIONS') ? 'human' : 'agent',
    waitingFor: 'what its close is refused for to be cleared',
  };
}

export function closeUnreadableHold(message: string): ReleaseHold {
  return {
    code: 'RELEASE_CLOSE_UNREADABLE',
    reason:
      'Whether this issue could be closed by a release could not be read, so the automatic ' +
      `release did not carry it: ${message}. Nothing was claimed or moved, and the next sweep ` +
      'reads it again.',
    owes: 'human',
    waitingFor: 'the close check to be readable',
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

const COVERS_LINE = /^When this was written it held \d+ issues? of this project.*$/m;

function coversLine(covers: readonly string[]): string[] {
  if (covers.length === 0) return [];
  const n = `${covers.length} issue${covers.length === 1 ? '' : 's'}`;
  const which = covers.map((id) => `\`${id}\``).join(', ');
  return ['', `When this was written it held ${n} of this project, oldest merge first: ${which}.`];
}

export function releaseHoldComment(
  hold: ReleaseHold,
  shared = false,
  covers: readonly string[] = [],
): string {
  const who = hold.owes === 'human' ? 'a person' : 'an agent run';
  const where = shared
    ? 'The same reason is on every issue of this project it holds, under `releaseHold`, and is ' +
      'written as a comment on the oldest of them alone; it is removed from each once it no ' +
      'longer holds.'
    : 'The same reason is on the issue itself, under `releaseHold`, and is removed once it no ' +
      'longer holds.';
  return [
    '**The automatic release is holding this issue at `awaiting_release`.**',
    '',
    hold.reason,
    '',
    `It is waiting for ${hold.waitingFor}, which ${who} owes. ${where}`,
    ...(shared ? coversLine(covers) : []),
    '',
    `\`release-hold: ${hold.code}\``,
  ].join('\n');
}

/** A comment's words as they are compared: the covered rows, a reading time and a reset set aside. */
function saidInComment(body: string): string {
  return comparable(body.replace(COVERS_LINE, '').replace(/\n{3,}/g, '\n\n'));
}

/**
 * A named row carries its hold's comment even where it was stored before one could be written, or
 * the row only now oldest (38d791 F1); a comment of the per-row wording already says it (834824 F1),
 * and so does one naming another set of covered rows (ISS-1346). Its reason joins what the row said.
 */
export async function commentOnce(
  row: { id: string; held: unknown },
  authorId: string,
  hold: ReleaseHold,
  covers: readonly string[],
): Promise<void> {
  const key = saidKey(hold);
  const said = saidOf(row.held);
  if (said.includes(key)) return;
  const body = releaseHoldComment(hold, true, covers);
  const legacy = !Array.isArray((row.held as Record<string, unknown> | null)?.said);
  const posted = legacy ? await saidBefore(row.id, hold, body) : false;
  await db.transaction(async (tx) => {
    // Guarded on the hold read, as `writeReleaseHolds` is: a hold replaced since keeps its own `said`.
    const updated = (await tx.execute(sql`
      UPDATE issues i
         SET session_context = jsonb_set(i.session_context,
                                         ${`{${RELEASE_HOLD_KEY},said}`}::text[],
                                         ${JSON.stringify(withSaid(said, key))}::jsonb, true)
       WHERE i.id = ${row.id}
         AND i.status = 'awaiting_release'
         AND i.release_batch_run_id IS NULL
         AND i.session_context -> ${RELEASE_HOLD_KEY} = ${JSON.stringify(row.held)}::jsonb
      RETURNING i.id
    `)) as unknown as Array<{ id: string }>;
    if (updated.length > 0 && !posted) {
      await tx.insert(comments).values({ issueId: row.id, authorId, body });
    }
  });
}

/** Only a hold stored before `said` existed is looked up in the thread; any other says itself. */
async function saidBefore(issueId: string, hold: ReleaseHold, body: string): Promise<boolean> {
  const wanted = new Set([saidInComment(body), saidInComment(releaseHoldComment(hold))]);
  const posted = await db
    .select({ body: comments.body })
    .from(comments)
    .where(and(eq(comments.issueId, issueId), like(comments.body, `%release-hold: ${hold.code}%`)));
  return posted.some((c) => wanted.has(saidInComment(c.body)));
}

/** `ISS-nn` for each row a shared hold is written onto, in the order given; a failed read names
 *  none rather than stopping the hold being written. */
async function coveredRows(issueIds: readonly string[]): Promise<string[]> {
  try {
    const shown = await issueDisplayIds([...issueIds]);
    return issueIds.map((id) => shown.get(id) ?? id);
  } catch (err) {
    logger.warn({ err }, 'release-hold: the covered rows could not be named');
    return [];
  }
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
 * Write one hold onto each row, with one comment where the hold changed to words not already
 * commented on that row since it was last held afresh (`said`, ISS-1346): a runner flipping between
 * two states is two reasons said once each, not a comment per flip, and the row's `releaseHold`
 * always carries the words standing now.
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
  /** The rows a hold shared by every row named is commented on; absent, each row's own. */
  commentOn?: ReadonlySet<string>;
}): Promise<ReleaseHoldTally> {
  const tally: ReleaseHoldTally = { written: 0, unchanged: 0, skipped: 0 };
  if (args.issueIds.length === 0) return tally;
  const rows = (await db
    .select({ id: issues.id, held: sql<unknown>`${issues.sessionContext} -> ${RELEASE_HOLD_KEY}` })
    .from(issues)
    .where(inArray(issues.id, [...args.issueIds]))) as Array<{ id: string; held: unknown }>;
  const shared = args.commentOn !== undefined;
  const covers = shared && args.commentOn?.size ? await coveredRows(args.issueIds) : [];

  for (const row of rows) {
    const hold = args.holdFor(row.id);
    const carried = readReleaseHold(row.held);
    if (carried && sameReleaseHold(carried, hold)) {
      tally.unchanged += 1;
      if (args.authorId && args.commentOn?.has(row.id)) {
        await commentOnce(row, args.authorId, carried, covers);
      }
      continue;
    }
    const said = carried ? saidOf(row.held) : [];
    const key = saidKey(hold);
    const named = args.authorId !== null && (args.commentOn?.has(row.id) ?? true);
    const comment = named && !said.includes(key);
    const stored: StoredReleaseHold = {
      at: args.now.toISOString(),
      status: 'awaiting_release',
      ...hold,
      said: comment ? withSaid(said, key) : said,
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
      if (comment && args.authorId) {
        const body = releaseHoldComment(hold, shared, covers);
        await tx.insert(comments).values({ issueId: row.id, authorId: args.authorId, body });
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
