// A mark made after a reopen is that round's landing (ISS-712, judge at dev.333): an issue reopened
// after its merge stamp kept the earlier round's stamp on a project that releases by trunk, so the
// next round's mark answered already_merged with merged_at before the reopen, and the run's end then
// read no landing since the reopen and handed the issue back. The earlier round's stamp is cleared
// in the mark's transaction, as a reopen on a change-request project clears it (REQ-63 BC-3), so the
// mark that follows writes the round's own. Only a mark naming another commit than the stamp's does
// so: the earlier round's commit named again is no new landing.

import type { OutboxActor } from '@forge/contracts/outbox-events';
import { sql } from 'drizzle-orm';
import type { Tx } from '../db/client.js';
import { mergeSinceLastReopenSql } from './host-landing.js';
import { supersedeMergeOnReopen } from './merge-record.js';

/** Clear a merge stamp an issue was reopened after, where `commit` is another; true where one was cleared. */
export async function supersedeStaleRoundMerge(
  tx: Tx,
  args: { issueId: string; actor: OutboxActor; commit: string | undefined },
): Promise<boolean> {
  const commit = args.commit?.trim().toLowerCase();
  if (!commit) return false;
  const stale = (await tx.execute(sql`
    SELECT 1 FROM issues i
     WHERE i.id = ${args.issueId}::uuid AND i.merged_at IS NOT NULL
       AND NOT ${mergeSinceLastReopenSql(sql`i`)}
       AND NOT starts_with(lower(coalesce(i.merged_commit_sha, i.merged_paths ->> 'commit', '')), ${commit})
       AND NOT starts_with(${commit}, lower(coalesce(i.merged_commit_sha, i.merged_paths ->> 'commit', '-')))`)) as unknown as unknown[];
  if (stale.length === 0) return false;
  return supersedeMergeOnReopen(tx, { issueId: args.issueId, actor: args.actor });
}
