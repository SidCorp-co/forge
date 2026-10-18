/** ISS-1215 — the one writer of `session_context.releaseHold`, its comment, and the clearers that
 *  take it off a row; what each kind of hold says is `release-hold-kinds.ts`'s. */

import { createHash } from 'node:crypto';
import { and, eq, inArray, like, or, sql } from 'drizzle-orm';
import { forgeAuthorId } from '../comments/forge-author.js';
import { postSystemComment } from '../comments/system-write.js';
import { db } from '../db/client.js';
import { comments, issues } from '../db/schema.js';
import { issueDisplayIds } from '../issues/display-ids.js';
import { logger } from '../logger.js';

export {
  closeRefusedHold,
  closeUnreadableHold,
  criteriaHold,
  criteriaUnreadableHold,
  cutFailedHold,
  gateUnreadableHold,
  NO_RELEASE_GATE_HOLD,
  queuedBehindHold,
  refusalHold,
  runtimeUnroutedHold,
  targetUndeclaredHold,
  withoutAges,
} from './release-hold-kinds.js';

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
  /** What the comment says: what holds it, what a person does, what happens then (ISS-1421 r8). */
  readonly words?: HoldWords | undefined;
}

export type HoldWords = readonly [holds: string, does: string, then: string];

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
  // A comment says its words, so two reasons worded alike are one thing said (ISS-1421 r8).
  const words = hold.words ? comparable(hold.words.join(' ')) : comparable(hold.reason);
  const said = [hold.code, words, hold.owes, hold.waitingFor].join('\u0000');
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
  const words = Array.isArray(v.words) && v.words.length === 3 && v.words.every((w) => text(w));
  return words
    ? { code, reason, owes, waitingFor, words: v.words as unknown as HoldWords }
    : { code, reason, owes, waitingFor };
}

/** A reason without the moment a probe was read, which moves every tick while the answer stands
 *  still; a stored reason keeps the timestamp of the reading that wrote it (ISS-1215, ISS-1286). */
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
const COVERS_LINE =
  /^(?:When this was written it held \d+ issues? of this project.*|This one comment stands for .*)$/m;
const COVERS_HEADING = /^(\*\*Held by the automatic release\*\*) for .*$/m;

const HOLD_HEADINGS = [
  '**Held by the automatic release**',
  '**The automatic release is holding this issue at Awaiting release.**',
] as const;

export function releaseHoldComment(
  hold: ReleaseHold,
  shared = false,
  covers: readonly string[] = [],
): string {
  // The rows one comment stands for go in its heading, so they are not a fourth sentence.
  const covered =
    shared && covers.length > 1
      ? ` for ${covers.slice(0, -1).join(', ')} and ${covers.at(-1)}`
      : '';
  if (hold.words) return `${HOLD_HEADINGS[0]}${covered}\n\n${hold.words.join(' ')}`;
  const who = hold.owes === 'human' ? 'a person' : 'an agent run';
  return `${HOLD_HEADINGS[0]}\n\n${hold.reason}\n\nIt is waiting for ${hold.waitingFor}, which ${who} owes.`;
}

/** A comment's words as they are compared: the covered rows, a reading time and a reset set aside. */
function saidInComment(body: string): string {
  const named = body.replace(COVERS_HEADING, '$1').replace(COVERS_LINE, '');
  return comparable(named.replace(/\n{3,}/g, '\n\n'));
}

/**
 * A named row carries its hold's comment even where it was stored before one could be written, or
 * the row only now oldest (38d791 F1); a comment of the per-row wording already says it (834824 F1),
 * and so does one naming another set of covered rows (ISS-1346). Its reason joins what the row said.
 */
export async function commentOnce(
  row: { id: string; held: unknown },
  hold: ReleaseHold,
  covers: readonly string[],
): Promise<void> {
  const key = saidKey(hold);
  const said = saidOf(row.held);
  if (said.includes(key)) return;
  const body = releaseHoldComment(hold, true, covers);
  const legacy = !Array.isArray((row.held as Record<string, unknown> | null)?.said);
  const posted = legacy ? await saidBefore(row.id, hold, body) : false;
  const authorId = await forgeAuthorId(db);
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
      await postSystemComment({ issueId: row.id, authorId, body }, tx);
    }
  });
}

/** Only a hold stored before `said` existed is looked up in the thread; any other says itself. A
 *  comment of the words before round 8 carried the hold's code on a line of its own, and is read
 *  as this hold's where it carries that code and this reason. */
async function saidBefore(issueId: string, hold: ReleaseHold, body: string): Promise<boolean> {
  const before = { ...hold, words: undefined };
  const wanted = new Set([saidInComment(body), saidInComment(releaseHoldComment(before))]);
  const reason = comparable(hold.reason);
  const posted = await db
    .select({ body: comments.body })
    .from(comments)
    .where(
      and(
        eq(comments.issueId, issueId),
        or(...HOLD_HEADINGS.map((h) => like(comments.body, `${h}%`))),
      ),
    );
  return posted.some(
    (c) =>
      wanted.has(saidInComment(c.body)) ||
      (c.body.includes(`release-hold: ${hold.code}`) && comparable(c.body).includes(reason)),
  );
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
 * Write one hold onto each row, with one comment where its words are new to `said` (ISS-1346).
 * The hold and its comment commit together, guarded on the hold the read saw and on the row still
 * waiting unclaimed, so of two racing writers only one writes and comments. `updated_at` is left
 * alone: the sweep's own cursor walks on it.
 */
export async function writeReleaseHolds(args: {
  issueIds: readonly string[];
  holdFor: (issueId: string) => ReleaseHold;
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
  const authorId = await forgeAuthorId(db);

  for (const row of rows) {
    const hold = args.holdFor(row.id);
    const carried = readReleaseHold(row.held);
    if (carried && sameReleaseHold(carried, hold)) {
      tally.unchanged += 1;
      if (args.commentOn?.has(row.id))
        await commentOnce(row, { ...carried, words: hold.words }, covers);
      continue;
    }
    const said = carried ? saidOf(row.held) : [];
    const key = saidKey(hold);
    const named = args.commentOn?.has(row.id) ?? true;
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
      if (comment) {
        const body = releaseHoldComment(hold, shared, covers);
        await postSystemComment({ issueId: row.id, authorId, body }, tx);
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
