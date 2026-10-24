/** Whether a wedge candidate's work already landed (ISS-564). Landed work is not handed back to be
 *  dispatched again: no status moves by itself, so the agent working it moves it to
 *  `awaiting_release` (REQ-45 BC-1, BC-7; issue-delivery `rule-wedge`). */

import { sql } from 'drizzle-orm';
import type { Db, Tx } from '../db/client.js';
import { mergeNotRecorded } from '../issues/index.js';

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
