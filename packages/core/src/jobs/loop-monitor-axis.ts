/** ISS-1273 — the axis `jobs/loop-monitor.ts` sweeps and the size of what it does not: every hop
 *  there starts from a `jobs` row, so a claim-held issue is outside all of them. */

import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { ISSUE_TERMINAL_STATUSES } from '../issues/status-sets.js';
import { holderFanout, readClaim } from '../pipeline/lease-fanout.js';
import { leaseIsWorkInProgress } from '../pipeline/session-claim.js';

export const LOOP_MONITOR_AXIS = 'job' as const;

/** What that axis cannot reach, counted so its silence is not read as a healthy lane, and where
 *  those rows ARE swept, so a reader has somewhere to go rather than a bare number. */
export interface LoopMonitorOutOfAxis {
  claimHeldIssues: number;
  sweptBy: 'pipeline/idle-issues.ts';
}

export async function countClaimHeldIssues(
  now: Date = new Date(),
  scope: { projectId?: string } = {},
): Promise<number> {
  const projectClause = scope.projectId ? sql`AND i.project_id = ${scope.projectId}` : sql``;
  const rows = (await db.execute(sql`
    SELECT i.session_context -> 'lease' AS lease
      FROM issues i
     WHERE i.status NOT IN (${sql.join(
       ISSUE_TERMINAL_STATUSES.map((s) => sql`${s}`),
       sql`, `,
     )})
       AND i.session_context -> 'lease' ->> 'holder' IS NOT NULL
       ${projectClause}
  `)) as unknown as Array<{ lease: unknown }>;
  const fanout = await holderFanout(
    rows.map((r) => r.lease),
    now,
  );
  return rows.filter((r) => leaseIsWorkInProgress(readClaim(r.lease, now, fanout).verdict)).length;
}
