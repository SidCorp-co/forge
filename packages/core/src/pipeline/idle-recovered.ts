// The idle-issues arm that clears a strand finding once it stops holding, so a recovered row stops
// claiming to be stuck.

import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  holderFanout,
  issueWorkInFlightSql,
  leaseIsWorkInProgress,
  leaseShowsHolderGone,
  readClaim,
  strandRuleFor,
} from '../issues/index.js';
import { logger } from '../observability/logger.js';
import { advanceSweep, sweepWindow } from './sweep-cursor.js';

/**
 * Clear a finding that has stopped holding.
 *
 * Without it the first strand a row is given is the last thing it ever says about itself, and a
 * recovered issue goes on claiming to be stuck — the same defect this pass exists to close, written
 * by the pass itself.
 */
export async function clearRecovered(now: Date, scope: { projectId?: string }): Promise<number> {
  const scoped = scope.projectId ? sql`AND i.project_id = ${scope.projectId}` : sql``;
  // This arm writes only to the rows it clears, so a page full of rows that are STILL stranded
  // would be re-read every tick and hide every row behind them for ever. The cursor is what walks
  // past them; it resumes after the last row read and wraps when a page comes back short.
  const cursorKey = `idle-recovered:${scope.projectId ?? '*'}`;
  const window = sweepWindow(cursorKey, now.toISOString());
  const resume = window.after
    ? sql`AND (i.updated_at, i.id) > (${window.after.ts}::timestamptz, ${window.after.id}::uuid)`
    : sql``;
  const rows = (await db.execute(sql`
    SELECT i.id, i.status, i.updated_at,
           i.updated_at::text AS cursor_ts,
           (SELECT w.lease FROM issue_work_state w WHERE w.issue_id = i.id)  AS lease,
           i.session_context -> 'strand' AS strand,
           (${NOTHING_LIVE_ON_THIS_ISSUE}) AS nothing_running
      FROM issues i
     WHERE i.session_context ? 'strand'
       AND i.updated_at <= ${window.until}::timestamptz
       ${scoped}
       ${resume}
     ORDER BY i.updated_at ASC, i.id ASC
     LIMIT ${IDLE_SCAN_LIMIT}
  `)) as unknown as Array<{
    id: string;
    status: string;
    updated_at: string;
    cursor_ts: string;
    lease: unknown;
    strand: unknown;
    nothing_running: boolean;
  }>;
  const lastRow = rows.at(-1);
  advanceSweep(
    cursorKey,
    window,
    lastRow ? { ts: lastRow.cursor_ts, id: lastRow.id } : null,
    rows.length === IDLE_SCAN_LIMIT,
  );
  if (rows.length === 0) return 0;

  const fanout = await holderFanout(
    rows.map((r) => r.lease),
    now,
  );
  let cleared = 0;
  for (const row of rows) {
    if (stillStranded(row, now, fanout)) continue;
    const held =
      row.strand === null || row.strand === undefined ? null : JSON.stringify(row.strand);
    const done = (await db.execute(sql`
      UPDATE issues i
         SET session_context = i.session_context - 'strand'
       WHERE i.id = ${row.id}
         AND coalesce(i.session_context -> 'strand', 'null'::jsonb)
             IS NOT DISTINCT FROM coalesce(${held}::jsonb, 'null'::jsonb)
      RETURNING i.id
    `)) as unknown as Array<{ id: string }>;
    if (done.length > 0) cleared += 1;
  }
  if (cleared > 0) logger.info({ cleared }, 'idle-issues: findings cleared on rows that recovered');
  return cleared;
}

function stillStranded(
  row: {
    status: string;
    updated_at: string;
    lease: unknown;
    strand: unknown;
    nothing_running: boolean;
  },
  now: Date,
  fanout: ReadonlyMap<string, number>,
): boolean {
  if (!row.nothing_running) return false;
  const rule = strandRuleFor(row.status);
  if (rule !== null && !rule.watch) return false;
  const lease = readClaim(row.lease, now, fanout);
  // A row that has MOVED carries a finding written at the status it left, whose new clock has not
  // run out; holding the old finding through it shows progress as a standing failure. Asked of a
  // row standing still, or of one whose holder is gone, it reads progress that never happened.
  if (
    hasMoved(row.status, row.strand) &&
    !leaseShowsHolderGone(lease.verdict) &&
    rule?.watch &&
    !graceSpent(row.updated_at, rule.graceMs, now)
  ) {
    return false;
  }
  return !leaseIsWorkInProgress(lease.verdict);
}

/** Left the status its finding was written at; unreadable reads as moved, as this arm did before. */
function hasMoved(status: string, strand: unknown): boolean {
  if (strand === null || typeof strand !== 'object' || Array.isArray(strand)) return true;
  const written = (strand as Record<string, unknown>).status;
  return typeof written !== 'string' || written !== status;
}

/** Whether a row has stood at its status long enough for that status's own clock to say anything. */
export function graceSpent(updatedAt: string, graceMs: number, now: Date): boolean {
  return now.getTime() - Date.parse(updatedAt) >= graceMs;
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
