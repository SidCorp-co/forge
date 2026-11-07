// The builds a project runs with no run record (ISS-1102): an issue held under a live lease on its
// work state while no live run covers it, which is how a direct-mode master builds through its own
// subagents. The issue's row reads it moving under "Run" (`issues/standing.ts:turnOf` holds a live or
// shared lease as running); this is the same reading for the bar on every project page, served
// beside the runs by `GET /api/projects/:id/runs/standing`, so the bar never says nothing runs
// while a row says it does, and never names a build no lease holds.

import type { IssueStatus } from '@forge/contracts/issue-machine';
import type { WorkStep } from '@forge/contracts/issue-vocabulary';
import { LIVE_PIPELINE_RUN_STATUSES } from '@forge/contracts/run-machine';
import type { RunLeasedBuild } from '@forge/contracts/run-standing';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { rowsOf } from '../db/raw-sql.js';
import { classifyLease } from '../issues/index.js';
import { formatIssueRef } from '../lib/issue-ref.js';
import { canonicalIssueKeySql, runGroupHolds } from '../lib/issue-run-group.js';
import { RUN_SCOPE_SQL } from './facts.js';

/** The statuses whose standing reads a live lease as the issue moving: past a draft, short of the release. */
const LEASE_MOVES: readonly IssueStatus[] = ['open', 'reopen', 'approved', 'in_progress'];

interface LeasedRow {
  iss_seq: number;
  title: string;
  status: IssueStatus;
  step: WorkStep | null;
  step_started_at: string | Date | null;
  lease: unknown;
  lease_device_id: string | null;
}

const iso = (at: string | Date | null) => (at === null ? null : new Date(at).toISOString());

/**
 * Every issue of the project a live or shared lease holds at a moving status, with no live run in
 * the runs list's scope over it by its id or its run group; `masterDeviceId` is the box the
 * project's master is on, so a lease written from it reads as the master's own build.
 */
export async function leasedBuildsOf(
  projectId: string,
  prefix: string | null,
  masterDeviceId: string | null,
  now: Date,
): Promise<RunLeasedBuild[]> {
  const rows = rowsOf<LeasedRow>(
    await db.execute(sql`
      SELECT i.iss_seq, i.title, i.status, w.step, w.step_started_at, w.lease, w.lease_device_id
        FROM issues i
        JOIN issue_work_state w ON w.issue_id = i.id
       WHERE i.project_id = ${projectId} AND i.archived_at IS NULL
         AND i.status IN (${sql.join(
           LEASE_MOVES.map((s) => sql`${s}`),
           sql`, `,
         )})
         AND w.lease IS NOT NULL AND w.lease <> 'null'::jsonb
         AND NOT EXISTS (
           SELECT 1 FROM pipeline_runs r
            WHERE r.project_id = i.project_id
              AND r.status IN (${sql.join(
                LIVE_PIPELINE_RUN_STATUSES.map((s) => sql`${s}`),
                sql`, `,
              )})
              AND ${RUN_SCOPE_SQL}
              AND (r.issue_id = i.id OR ${runGroupHolds(sql`r.metadata`, canonicalIssueKeySql(sql`i.iss_seq`))}))
       ORDER BY w.step_started_at DESC NULLS LAST, i.iss_seq DESC`),
  );
  return rows.flatMap((r): RunLeasedBuild[] => {
    const read = classifyLease({ lease: r.lease, now, fanout: 1 });
    if ((read.verdict !== 'live' && read.verdict !== 'shared') || !read.holder) return [];
    return [
      {
        issue: { key: formatIssueRef(prefix, Number(r.iss_seq)), title: r.title, status: r.status },
        step: r.step,
        stepStartedAt: iso(r.step_started_at),
        holder: read.holder,
        byMaster: masterDeviceId !== null && r.lease_device_id === masterDeviceId,
        expiresAt: read.expiresAt?.toISOString() ?? null,
      },
    ];
  });
}
