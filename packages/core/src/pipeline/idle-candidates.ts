/**
 * The idle sweep's candidates (idle-issues.ts): the page its cursor reaches this pass, and every row
 * owed a sighting beside it (owed-sighting.ts).
 */

import { type SQL, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { issueStatuses } from '../db/schema.js';
import { issueWorkInFlightSql } from '../issues/issue-lease.js';
import { statusEnteredAtSql } from '../issues/status-entered-at.js';
import { logger } from '../logger.js';
import {
  FRESH_SIGHTING_LIMIT,
  pendingConditionSql,
  pendingSightingLimit,
  unraisedConditionSql,
  withOwed,
} from './owed-sighting.js';
import { isTerminalPlacement } from './status-assertions.js';
import { SHORTEST_GRACE_MS, STRAND_RULES, WATCHED_STATUSES } from './strand-rules.js';
import { advanceSweep, type SweepPosition, sweepWindow } from './sweep-cursor.js';

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
  /** Text, not a `Date`: `db.execute` hands raw SQL results back unparsed. */
  updated_at: string;
  /** When the row entered its status, which is what its notice counts from; `updated_at` moves on any write. */
  entered_at: string;
  merged_at: string | null;
  lease: unknown;
  strand: unknown;
  release_hold: unknown;
  ever_ran: boolean;
  cursor_ts: string;
}

/** Terminal, plus every status the rule table declares at rest. Everything else is a candidate. */
const NOT_WATCHED: readonly string[] = issueStatuses.filter(
  (s) => isTerminalPlacement(s) || !STRAND_RULES[s].watch,
);

/** One read of the candidates: a watched status, a live project, nothing running, then `where`. */
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
  const scoped = args.scope.projectId ? sql`AND i.project_id = ${args.scope.projectId}` : sql``;
  return (await db.execute(sql`
    SELECT i.id, i.project_id, i.iss_seq, i.status, i.title, i.updated_at, i.merged_at,
           ${statusEnteredAtSql({ id: sql`i.id`, status: sql`i.status`, createdAt: sql`i.created_at` })}::text AS entered_at,
           p.issue_prefix, p.name AS project_name,
           i.session_context -> 'lease'  AS lease,
           i.session_context -> 'strand' AS strand,
           i.session_context -> 'releaseHold' AS release_hold,
           i.updated_at::text AS cursor_ts,
           EXISTS (SELECT 1 FROM pipeline_runs pr WHERE pr.issue_id = i.id) AS ever_ran
      FROM issues i
      JOIN projects p ON p.id = i.project_id
     WHERE i.status NOT IN (${excluded})
       AND p.archived_at IS NULL
       AND ${NOTHING_LIVE_ON_THIS_ISSUE}
       ${scoped}
       AND ${args.where}
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
    ? sql`AND (i.updated_at, i.id) > (${after.ts}::timestamptz, ${after.id}::uuid)`
    : sql``;

  const rows = await selectCandidates({
    scope,
    where: sql`i.updated_at < ${window.until}::timestamptz ${resume}`,
    order: sql`i.updated_at ASC, i.id ASC`,
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
    order: sql`i.updated_at ASC, i.id ASC`,
    limit: pendingSightingLimit(IDLE_SCAN_LIMIT),
  });
  const fresh = await selectCandidates({
    scope,
    where: sql`${unraisedConditionSql(sql`i.id`, IDLE_KEY_SUFFIX)} AND i.updated_at < ${dueBeforeSql(now)}`,
    order: sql`i.updated_at DESC, i.id DESC`,
    limit: FRESH_SIGHTING_LIMIT,
  });
  return withOwed(rows, pending, fresh);
}
