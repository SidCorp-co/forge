/** ISS-1273 — the axis `jobs/loop-monitor.ts` sweeps and the size of what it does not: every hop
 *  there starts from a `jobs` row, so a claim-held issue is outside all of them. */

import { ISSUE_TERMINAL_STATUSES } from '@forge/contracts/issue-machine';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { logger } from '../logger.js';
import { holderFanout, readClaim } from '../pipeline/lease-fanout.js';
import { leaseIsWorkInProgress } from '../pipeline/session-claim.js';

export const LOOP_MONITOR_AXIS = 'job' as const;

/** What that axis cannot reach, and where those rows ARE swept. */
export interface LoopMonitorOutOfAxis {
  claimHeldIssues: number;
  sweptBy: 'pipeline/idle-issues.ts';
}

const NON_TERMINAL = sql`i.status NOT IN (${sql.join(
  ISSUE_TERMINAL_STATUSES.map((s) => sql`${s}`),
  sql`, `,
)})`;

export async function countClaimHeldIssues(
  now: Date = new Date(),
  scope: { projectId?: string } = {},
): Promise<number> {
  const projectClause = scope.projectId ? sql`AND i.project_id = ${scope.projectId}` : sql``;
  const rows = (await db.execute(sql`
    SELECT (SELECT w.lease FROM issue_work_state w WHERE w.issue_id = i.id) AS lease
      FROM issues i
     WHERE ${NON_TERMINAL}
       AND (SELECT w.lease ->> 'holder' FROM issue_work_state w WHERE w.issue_id = i.id) IS NOT NULL
       ${projectClause}
  `)) as unknown as Array<{ lease: unknown }>;
  const fanout = await holderFanout(
    rows.map((r) => r.lease),
    now,
  );
  return rows.filter((r) => leaseIsWorkInProgress(readClaim(r.lease, now, fanout).verdict)).length;
}

/** ISS-1273 — the same count for several projects at once, which `projects/health-routes.ts`
 *  needs: it is one of the two readers this pair got, the other being the tick log below. */
export async function countClaimHeldIssuesByProject(
  projectIds: readonly string[],
  now: Date = new Date(),
): Promise<Map<string, number>> {
  const counts = new Map<string, number>(projectIds.map((id) => [id, 0]));
  if (projectIds.length === 0) return counts;
  const rows = (await db.execute(sql`
    SELECT i.project_id, (SELECT w.lease FROM issue_work_state w WHERE w.issue_id = i.id) AS lease
      FROM issues i
     WHERE ${NON_TERMINAL}
       AND (SELECT w.lease ->> 'holder' FROM issue_work_state w WHERE w.issue_id = i.id) IS NOT NULL
       AND i.project_id IN (${sql.join(
         projectIds.map((id) => sql`${id}::uuid`),
         sql`, `,
       )})
  `)) as unknown as Array<{ project_id: string; lease: unknown }>;
  const fanout = await holderFanout(
    rows.map((r) => r.lease),
    now,
  );
  for (const row of rows) {
    if (!leaseIsWorkInProgress(readClaim(row.lease, now, fanout).verdict)) continue;
    const key = String(row.project_id);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/** What a reader is told about the axis and what sits outside it, wherever it is served. */
export interface LoopMonitorCoverage extends LoopMonitorOutOfAxis {
  axis: typeof LOOP_MONITOR_AXIS;
}

export function loopMonitorCoverage(claimHeldIssues: number): LoopMonitorCoverage {
  return { axis: LOOP_MONITOR_AXIS, claimHeldIssues, sweptBy: 'pipeline/idle-issues.ts' };
}

/** The same answer, said out loud once per tick — zero included, because a line that appeared
 *  only above zero would leave its silence meaning "none held" and "nobody counted" alike. */
export function reportLoopMonitorCoverage(claimHeldIssues: number): LoopMonitorCoverage {
  const coverage = loopMonitorCoverage(claimHeldIssues);
  logger.info(
    coverage,
    'loop-monitor: swept the job axis; issues held on the claim lane are outside every hop it runs',
  );
  return coverage;
}
