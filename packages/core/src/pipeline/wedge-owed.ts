/** The `in_progress` work the wedge net found nothing holding and left where it stands (ISS-1104):
 *  no sweep moves a status on a proxy signal, so the project's master, woken once per stretch at
 *  `in_progress`, decides whether to hand it back, hold it or carry it on (issue-delivery `rule-wedge`). */

import { type SQL, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { activeIssuePrefix, issueWorkInFlightSql } from '../issues/index.js';
import { formatIssueRef } from '../lib/issue-ref.js';
import { holdsOpenHumanQuestion } from './ports.js';
import { landedWorkStands } from './wedge-landed.js';
import { readWedgeLease, wedgeLeaseHoldsTheIssue, wedgeLeftUnheldMarker } from './wedge-lease.js';

/**
 * When the issue row `i` entered the `in_progress` it stands at: its latest move there, or its birth
 * where none is recorded. What the net's notice is told once per: a new claim is a new stretch.
 */
export const inProgressSinceSql = (i: SQL): SQL => sql`COALESCE((
    SELECT max(k.created_at) FROM kernel_transitions k
     WHERE k.entity = 'issue' AND k.entity_id = ${i}.id AND k.to_status = 'in_progress'
  ), ${i}.created_at)`;

/** An unheld wedge its master owes a decision on. */
export type WedgedWorkOwed = {
  issueId: string;
  key: string;
  /** ISO 8601: when it entered `in_progress`, so a new claim is new work for the master. */
  since: string;
};

/**
 * The project's `in_progress` issues the net told unheld for the stretch they stand in now, which
 * nothing has taken up since: no job, run or live lease holds one, no person owes an answer on it,
 * and its work did not land this round (that is `landedWorkOwed`). One leaves this list by a hold,
 * by a move, or by a run taking it.
 */
export async function wedgedWorkOwed(projectId: string): Promise<WedgedWorkOwed[]> {
  const rows = (await db.execute(sql`
    SELECT i.id, i.iss_seq, ${inProgressSinceSql(sql`i`)} AS since,
           (SELECT w.lease FROM issue_work_state w WHERE w.issue_id = i.id) AS lease
      FROM issues i
     WHERE i.project_id = ${projectId}::uuid
       AND i.status = 'in_progress'
       AND NOT ${holdsOpenHumanQuestion(sql`i.id`)}
       AND NOT ${issueWorkInFlightSql({
         issueId: sql`i.id`,
         projectId: sql`i.project_id`,
         issueKey: sql`'ISS-' || i.iss_seq`,
       })}
     ORDER BY since, i.id
  `)) as unknown as Array<{ id: string; iss_seq: number; since: Date | string; lease: unknown }>;
  if (rows.length === 0) return [];
  const now = new Date();
  const prefix = await activeIssuePrefix(projectId);
  const owed: WedgedWorkOwed[] = [];
  for (const row of rows) {
    if (wedgeLeaseHoldsTheIssue(readWedgeLease(row.lease, now))) continue;
    if (await landedWorkStands(db, row.id)) continue;
    const since = new Date(row.since);
    const [told] = (await db.execute(sql`
      SELECT 1 FROM comments c
       WHERE c.issue_id = ${row.id}::uuid
         AND strpos(c.body, ${wedgeLeftUnheldMarker(since)}) > 0
       LIMIT 1
    `)) as unknown as unknown[];
    if (!told) continue;
    owed.push({
      issueId: row.id,
      key: formatIssueRef(prefix, row.iss_seq),
      since: since.toISOString(),
    });
  }
  return owed;
}
