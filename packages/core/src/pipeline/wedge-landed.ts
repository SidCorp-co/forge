/** Whether a wedge candidate's work already landed (ISS-564), and the landed work its master owes a
 *  move. Landed work is not handed back to be dispatched again: no status moves by itself, so the
 *  agent owing it moves it to `awaiting_release` (REQ-45 BC-1, BC-7; issue-delivery `rule-wedge`). */

import { sql } from 'drizzle-orm';
import { type Db, db, type Tx } from '../db/client.js';
import { activeIssuePrefix, issueWorkInFlightSql, mergeNotRecorded } from '../issues/index.js';
import { formatIssueRef } from '../lib/issue-ref.js';
import { readWedgeLease, wedgeLeaseHoldsTheIssue, wedgeLeftLandedMarker } from './wedge-lease.js';

/** The mark the landed work stands on. */
export type LandedWork = {
  mergedAt: Date;
  commit: string | null;
  landing: string | null;
};

/**
 * The issue's mark, where it is this round's and the move to `awaiting_release` would take it; null
 * otherwise. A mark the issue was reopened after is the round a failing verdict sent back, so it
 * is not this round's landing. A mark that guard refuses (a design approval's stamp, a local mark
 * on a project only its host's merge lands) is not ready for release either
 * (`issues/merged-at.ts:mergeNotRecorded`).
 */
export async function landedWorkStands(
  executor: Db | Tx,
  issueId: string,
): Promise<LandedWork | null> {
  const [row] = (await executor.execute(sql`
    SELECT i.merged_at, i.merged_commit_sha, i.merged_landing
      FROM issues i
     WHERE i.id = ${issueId}::uuid
       AND i.merged_at IS NOT NULL
       AND NOT EXISTS (
             SELECT 1 FROM kernel_transitions k
              WHERE k.entity = 'issue' AND k.entity_id = i.id
                AND k.to_status = 'reopen'
                AND k.created_at > i.merged_at
           )
  `)) as unknown as Array<{
    merged_at: Date | string;
    merged_commit_sha: string | null;
    merged_landing: string | null;
  }>;
  if (!row) return null;
  if (await mergeNotRecorded(executor, { issueId, to: 'awaiting_release' })) return null;
  return {
    mergedAt: new Date(row.merged_at),
    commit: nonEmpty(row.merged_commit_sha),
    landing: nonEmpty(row.merged_landing),
  };
}

function nonEmpty(value: string | null): string | null {
  return value !== null && value.trim() !== '' ? value : null;
}

/** Landed work its master owes the move to `awaiting_release`. */
export type LandedWorkOwed = {
  issueId: string;
  key: string;
  commit: string | null;
  /** ISO 8601: when the mark stood, so a new mark is new work for the master. */
  mergedAt: string;
};

/**
 * The project's `in_progress` issues the wedge pass left because their work landed, which nothing
 * has taken up since: each carries the pass's notice for the mark that stands now, and no job, run
 * or live lease holds it. Its master owes each the move to `awaiting_release` (ISS-564 round 2), and
 * one leaves this list by that move, by a run taking it, or by its mark being cleared or replaced.
 */
export async function landedWorkOwed(projectId: string): Promise<LandedWorkOwed[]> {
  const rows = (await db.execute(sql`
    SELECT i.id, i.iss_seq,
           (SELECT w.lease FROM issue_work_state w WHERE w.issue_id = i.id) AS lease
      FROM issues i
     WHERE i.project_id = ${projectId}::uuid
       AND i.status = 'in_progress'
       AND i.merged_at IS NOT NULL
       AND NOT ${issueWorkInFlightSql({
         issueId: sql`i.id`,
         projectId: sql`i.project_id`,
         issueKey: sql`'ISS-' || i.iss_seq`,
       })}
     ORDER BY i.merged_at, i.id
  `)) as unknown as Array<{ id: string; iss_seq: number; lease: unknown }>;
  if (rows.length === 0) return [];
  const now = new Date();
  const prefix = await activeIssuePrefix(projectId);
  const owed: LandedWorkOwed[] = [];
  for (const row of rows) {
    if (wedgeLeaseHoldsTheIssue(readWedgeLease(row.lease, now))) continue;
    const landed = await landedWorkStands(db, row.id);
    if (!landed) continue;
    const [told] = (await db.execute(sql`
      SELECT 1 FROM comments c
       WHERE c.issue_id = ${row.id}::uuid
         AND strpos(c.body, ${wedgeLeftLandedMarker(landed)}) > 0
       LIMIT 1
    `)) as unknown as unknown[];
    if (!told) continue;
    owed.push({
      issueId: row.id,
      key: formatIssueRef(prefix, row.iss_seq),
      commit: landed.commit,
      mergedAt: landed.mergedAt.toISOString(),
    });
  }
  return owed;
}
