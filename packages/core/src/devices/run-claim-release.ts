// The issue claims a closed run held, given back by its close (ISS-737).
//
// A run dispatched by a master claims its issue with the plugin's `forge claim`, under the id its
// tree holds (`<git dir>/forge-run-id`, minted by `forge brief`). Closing the run gave its tree back
// and left that claim live for its whole duration: subagents run inside the master's process, so
// the pid the claim records stays alive and nothing could tell the run was over, and the next run
// on the issue was refused on every write until the claim ran out (catalog-fe ISS-39, adminhub-api
// ISS-32, 2026-10-29). The box reads the id off the tree before it gives the tree back and names it
// on the close; the close releases what that id holds.
//
// contract -> github.com/SidCorp-co/forge-plugin:plugin/src/flow/lease.mjs — a release is the
// holder taken off and `released` stamped, which that file reads as no lease and a take reaches.
// `releasedBy` says which release it was, so a reader never takes it for a reclaim or a crash.

import { sql } from 'drizzle-orm';
import type { Tx } from '../db/client.js';

/** What a release by a run's close stamps on the claim beside `released`. */
export const RELEASED_BY_RUN_CLOSE = 'run-close';

/**
 * Take the holder off every claim in `projectId` held by one of `holders` and written from this box
 * or from none, and answer the issue keys whose claim was given back. A claim another box wrote is
 * never touched: a box releases only its own.
 */
export async function releaseRunClaims(
  tx: Tx,
  args: {
    projectId: string;
    deviceId: string;
    runId: string | null;
    holders: readonly string[];
    at: Date;
  },
): Promise<string[]> {
  const holders = [...new Set(args.holders.map((h) => h.trim()).filter((h) => h.length > 0))];
  if (holders.length === 0) return [];
  const stamp = {
    holder: '',
    released: args.at.toISOString(),
    releasedBy: RELEASED_BY_RUN_CLOSE,
    ...(args.runId ? { releasedRun: args.runId } : {}),
  };
  const rows = (await tx.execute(sql`
    UPDATE issue_work_state w
       SET lease = w.lease || ${JSON.stringify(stamp)}::jsonb,
           updated_at = now()
      FROM issues i
     WHERE w.issue_id = i.id
       AND i.project_id = ${args.projectId}
       AND jsonb_typeof(w.lease) = 'object'
       AND w.lease_holder IN (${sql.join(
         holders.map((h) => sql`${h}`),
         sql`, `,
       )})
       AND (w.lease_device_id IS NULL OR w.lease_device_id = ${args.deviceId})
    RETURNING 'ISS-' || i.iss_seq AS key
  `)) as unknown as Array<{ key: string }>;
  return rows.map((r) => r.key).sort();
}
