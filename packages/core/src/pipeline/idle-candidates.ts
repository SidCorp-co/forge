/**
 * The idle sweep's candidates (idle-issues.ts): the page its cursor reaches this pass, and every row
 * owed a sighting beside it (owed-sighting.ts).
 */

import { type SQL, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { issueStatuses } from '../db/schema.js';
import { issueWorkInFlightSql } from '../issues/issue-lease.js';
import { lastWorkedAtSql, statusEnteredAtSql } from '../issues/status-entered-at.js';
import { logger } from '../logger.js';
import { projectHasAdminSql } from '../notifications/project-admins.js';
import {
  ARRIVALS_PER_PASS,
  FRESH_SIGHTING_LIMIT,
  pendingConditionSql,
  pendingSightingLimit,
  pendingSinceSql,
  unraisedConditionSql,
  withOwed,
} from './owed-sighting.js';
import { type LeaseReading, leaseShowsHolderGone } from './session-claim.js';
import { isTerminalPlacement } from './status-assertions.js';
import { SHORTEST_GRACE_MS, STRAND_RULES, WATCHED_STATUSES } from './strand-rules.js';
import {
  advanceArrivals,
  advanceSweep,
  arrivalMark,
  type SweepPosition,
  sweepWindow,
} from './sweep-cursor.js';

export const IDLE_KEY_SUFFIX = ':idle';

export function strandResolutionKey(issueId: string): string {
  return `issue:${issueId}${IDLE_KEY_SUFFIX}`;
}

/** A USE of the fleet-wide predicate, never a second copy: `issues/issue-lease.ts` is the only
 *  place that SQL is written (ISS-1109), and a sweep answering it another way reports as stranded
 *  exactly the issues a box is holding. This binding only carries the `issues i` alias in. */
export const NOTHING_LIVE_ON_THIS_ISSUE = sql`NOT ${issueWorkInFlightSql({
  issueId: sql`i.id`,
  projectId: sql`i.project_id`,
  issueKey: sql`'ISS-' || i.iss_seq`, // ISS-992:canonical
})}`;

/** How many rows one arm reads per pass, matching the other sweep axes. */
export const IDLE_SCAN_LIMIT = 200;

export interface CandidateRow {
  id: string;
  project_id: string;
  iss_seq: number;
  issue_prefix: string | null;
  project_name: string;
  status: string;
  title: string;
  /** When the row entered its status, which is what its notice counts from; `updated_at` moves on any write. */
  entered_at: string;
  /** When nothing has worked the row since — the later of `entered_at` and its last job, run or run
   *  session ending — as text: what its status's grace runs from, and what the cursors page by. */
  idle_since: string;
  merged_at: string | null;
  lease: unknown;
  strand: unknown;
  release_hold: unknown;
  ever_ran: boolean;
  cursor_ts: string;
  /** When the row spends its status's grace, as ISO text: where the arrival read resumes. */
  due_at: string;
}

/** Left the status its finding was written at; unreadable reads as moved, as `clearRecovered`
 *  did before. */
export function hasMoved(status: string, strand: unknown): boolean {
  if (strand === null || typeof strand !== 'object' || Array.isArray(strand)) return true;
  const written = (strand as Record<string, unknown>).status;
  return typeof written !== 'string' || written !== status;
}

/** A holder gone, or a claim this pass stopped on a finding still at the row's status: the release
 *  is the sweep's own write, and starting the grace again would let that finding's notice go stale. */
export function graceWaived(row: CandidateRow, lease: LeaseReading): boolean {
  return (
    leaseShowsHolderGone(lease.verdict) || (lease.stopped && !hasMoved(row.status, row.strand))
  );
}

/** Terminal, plus every status the rule table declares at rest. Everything else is a candidate. */
const NOT_WATCHED: readonly string[] = issueStatuses.filter(
  (s) => isTerminalPlacement(s) || !STRAND_RULES[s].watch,
);

/** When a row at its status spends that status's grace: the order rows arrive in as they come due. */
function dueAtSql(): SQL {
  const arms = WATCHED_STATUSES.map((status) => {
    const rule = STRAND_RULES[status];
    const ms = rule.watch ? rule.graceMs : 0;
    return sql`WHEN ${status} THEN ${ms} * interval '1 millisecond'`;
  });
  return sql`(i.idle_since + CASE i.status ${sql.join(arms, sql` `)} ELSE interval '0' END)`;
}

/** When nothing has worked the row since, never its last write: a title edit is not work (ISS-1229). */
const IDLE_SINCE = lastWorkedAtSql({
  id: sql`w.id`,
  status: sql`w.status`,
  createdAt: sql`w.created_at`,
  projectId: sql`w.project_id`,
  issueKey: sql`'ISS-' || w.iss_seq`, // ISS-992:canonical
});

/** One read of the candidates: a watched status, a live project, nothing running, then `where`.
 *  `OFFSET 0` keeps the inner read whole, so `i.idle_since` is computed once a row: inlined into
 *  every clause, a 1,000-row board planned past the JIT threshold and spent 24s compiling it. */
async function selectCandidates(args: {
  scope: { projectId?: string };
  where: SQL;
  order: SQL;
  limit: number;
}): Promise<CandidateRow[]> {
  // NOT IN, never IN: `issues.status` is a text column, so a value this build's enum has not caught
  // up with must reach TypeScript to be named rather than be filtered out here.
  const excluded = sql.join(
    NOT_WATCHED.map((s) => sql`${s}`),
    sql`, `,
  );
  const scoped = args.scope.projectId ? sql`AND w.project_id = ${args.scope.projectId}` : sql``;
  const live = sql`NOT ${issueWorkInFlightSql({
    issueId: sql`w.id`,
    projectId: sql`w.project_id`,
    issueKey: sql`'ISS-' || w.iss_seq`, // ISS-992:canonical
  })}`;
  return (await db.execute(sql`
    SELECT i.id, i.project_id, i.iss_seq, i.status, i.title, i.merged_at, i.entered_at,
           i.issue_prefix, i.project_name, i.lease, i.strand, i.release_hold, i.ever_ran,
           i.idle_since::text AS idle_since,
           i.idle_since::text AS cursor_ts,
           to_char(${dueAtSql()} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS due_at
      FROM (
        SELECT w.id, w.project_id, w.iss_seq, w.status, w.title, w.merged_at,
               ${statusEnteredAtSql({ id: sql`w.id`, status: sql`w.status`, createdAt: sql`w.created_at` })}::text AS entered_at,
               ${IDLE_SINCE} AS idle_since,
               p.issue_prefix, p.name AS project_name,
               w.session_context -> 'lease'  AS lease,
               w.session_context -> 'strand' AS strand,
               w.session_context -> 'releaseHold' AS release_hold,
               EXISTS (SELECT 1 FROM pipeline_runs pr WHERE pr.issue_id = w.id) AS ever_ran
          FROM issues w
          JOIN projects p ON p.id = w.project_id
         WHERE w.status NOT IN (${excluded})
           AND p.archived_at IS NULL
           AND ${live}
           ${scoped}
        OFFSET 0
      ) i
     WHERE ${args.where}
     ORDER BY ${args.order}
     LIMIT ${args.limit}
  `)) as unknown as CandidateRow[];
}

/** The time before which a row at its status has spent that status's grace; an unclassified status at once. */
function dueBeforeSql(now: Date): SQL {
  const arms = WATCHED_STATUSES.map((status) => {
    const rule = STRAND_RULES[status];
    const due = new Date(now.getTime() - (rule.watch ? rule.graceMs : 0)).toISOString();
    return sql`WHEN ${status} THEN ${due}::timestamptz`;
  });
  return sql`(CASE i.status ${sql.join(arms, sql` `)} ELSE ${now.toISOString()}::timestamptz END)`;
}

export async function readCandidates(
  now: Date,
  scope: { projectId?: string },
): Promise<CandidateRow[]> {
  const cursorKey = `idle-issues:${scope.projectId ?? '*'}`;
  const until = new Date(now.getTime() - SHORTEST_GRACE_MS).toISOString();
  const window = sweepWindow(cursorKey, until);
  const after = window.after;
  const resume = after
    ? sql`AND (i.idle_since, i.id) > (${after.ts}::timestamptz, ${after.id}::uuid)`
    : sql``;

  const rows = await selectCandidates({
    scope,
    where: sql`i.idle_since < ${window.until}::timestamptz ${resume}`,
    order: sql`i.idle_since ASC, i.id ASC`,
    limit: IDLE_SCAN_LIMIT,
  });

  const filled = rows.length === IDLE_SCAN_LIMIT;
  const lastRow = rows.at(-1);
  const last: SweepPosition | null = lastRow ? { ts: lastRow.cursor_ts, id: lastRow.id } : null;
  advanceSweep(cursorKey, window, last, filled);
  if (filled) {
    logger.warn(
      { limit: IDLE_SCAN_LIMIT, resumesAfter: last?.ts ?? null },
      'idle-issues: the scan filled its page — the rest is read on later passes',
    );
  }

  const pending = await selectCandidates({
    scope,
    where: pendingConditionSql(sql`i.id`, IDLE_KEY_SUFFIX),
    order: sql`${pendingSinceSql(sql`i.id`, IDLE_KEY_SUFFIX)} ASC, i.id ASC`,
    limit: pendingSightingLimit(IDLE_SCAN_LIMIT),
  });
  const unraisedDue = sql`${unraisedConditionSql(sql`i.id`, IDLE_KEY_SUFFIX)} AND i.idle_since < ${dueBeforeSql(now)}
      AND ${projectHasAdminSql(sql`i.project_id`)}`;
  // The fresh cursor passes a position once a traversal, so a row coming due behind it would wait
  // for the wrap: every row that came due since the last pass is read in the order it came due.
  const arrivalKey = `idle-arrivals:${scope.projectId ?? '*'}`;
  const mark = arrivalMark(arrivalKey, now, new Date(now.getTime() - SHORTEST_GRACE_MS));
  const arrived = await selectCandidates({
    scope,
    where: sql`${unraisedDue} AND (${dueAtSql()}, i.id) > (${mark.ts}::timestamptz, ${mark.id}::uuid)`,
    order: sql`${dueAtSql()} ASC, i.id ASC`,
    limit: ARRIVALS_PER_PASS,
  });
  const lastArrived = arrived.at(-1);
  advanceArrivals(
    arrivalKey,
    now,
    lastArrived ? { ts: lastArrived.due_at, id: lastArrived.id } : null,
    arrived.length === ARRIVALS_PER_PASS,
  );
  // Newest first, resuming past the rows read last pass: one the judge declines to raise (a live
  // claim) stays unraised, and without the cursor those rows would hold every fresh slot.
  const freshKey = `idle-fresh:${scope.projectId ?? '*'}`;
  const freshWindow = sweepWindow(freshKey, now.toISOString());
  const older = freshWindow.after
    ? sql`AND (i.idle_since, i.id) < (${freshWindow.after.ts}::timestamptz, ${freshWindow.after.id}::uuid)`
    : sql``;
  const fresh = await selectCandidates({
    scope,
    where: sql`${unraisedDue} ${older}`,
    order: sql`i.idle_since DESC, i.id DESC`,
    limit: FRESH_SIGHTING_LIMIT,
  });
  const lastFresh = fresh.at(-1);
  advanceSweep(
    freshKey,
    freshWindow,
    lastFresh ? { ts: lastFresh.cursor_ts, id: lastFresh.id } : null,
    fresh.length === FRESH_SIGHTING_LIMIT,
  );
  return withOwed(rows, pending, arrived, fresh);
}
