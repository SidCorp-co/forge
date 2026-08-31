/**
 * The compact project-state digest `forge_pm.snapshot` primes a PM decision
 * turn with. Six independent reads keyed on `project_id`, trimmed to a small
 * predictable payload (target < 2 KB JSON for a typical project) so the digest
 * fits in the agent's priming context without crowding out memory excerpts.
 */

import { and, asc, count, desc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { issues, jobs } from '../db/schema.js';
import { readRunnerLoad } from './runner-load-service.js';

const ACTIVE_JOB_STATUSES = ['queued', 'dispatched', 'running'] as const;
const ACTIVE_PIPELINE_STATUSES = ['approved', 'in_progress', 'developed', 'testing'] as const;

const FAILURE_REASON_TRUNC = 200;

function truncate(value: string | null, max: number): string | null {
  if (!value) return value;
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

/** The digest the PM agent primes a decision turn with. */
export async function readPmSnapshot(projectId: string) {
  const countsRows = await db
    .select({ status: issues.status, n: count() })
    .from(issues)
    .where(eq(issues.projectId, projectId))
    .groupBy(issues.status);
  const countsByStatus: Record<string, number> = {};
  for (const row of countsRows) {
    countsByStatus[row.status] = Number(row.n);
  }

  const activeJobsRows = await db
    .select({
      id: jobs.id,
      type: jobs.type,
      status: jobs.status,
      issueId: jobs.issueId,
      queuedAt: jobs.queuedAt,
    })
    .from(jobs)
    .where(and(eq(jobs.projectId, projectId), inArray(jobs.status, [...ACTIVE_JOB_STATUSES])))
    .orderBy(desc(jobs.queuedAt))
    .limit(20);

  const stalledIssuesRows = await db
    .select({
      id: issues.id,
      issueId: issues.issSeq,
      status: issues.status,
      updatedAt: issues.updatedAt,
    })
    .from(issues)
    .where(
      and(
        eq(issues.projectId, projectId),
        inArray(issues.status, [...ACTIVE_PIPELINE_STATUSES]),
        sql`NOT EXISTS (
          SELECT 1 FROM ${jobs} j
          WHERE j.issue_id = ${issues.id}
            AND j.status IN ('queued','dispatched','running')
        )`,
      ),
    )
    .orderBy(asc(issues.updatedAt))
    .limit(10);

  const [queuedCountRow] = await db
    .select({ n: count() })
    .from(jobs)
    .where(and(eq(jobs.projectId, projectId), eq(jobs.status, 'queued')));
  const queuedCount = Number(queuedCountRow?.n ?? 0);

  const recentFailuresRows = await db
    .select({
      id: jobs.id,
      type: jobs.type,
      failureKind: jobs.failureKind,
      failureReason: jobs.failureReason,
      finishedAt: jobs.finishedAt,
    })
    .from(jobs)
    .where(and(eq(jobs.projectId, projectId), eq(jobs.status, 'failed')))
    .orderBy(desc(jobs.finishedAt))
    .limit(5);

  const runnerHealth = (await readRunnerLoad(projectId)).map((r) => ({
    id: r.id,
    type: r.type,
    status: r.status,
    lastSeenAt: r.lastSeenAt,
    inFlight: r.inFlight,
  }));

  return {
    countsByStatus,
    activeJobs: activeJobsRows,
    stalledIssues: stalledIssuesRows.map((r) => ({
      id: r.id,
      issueId: `ISS-${r.issueId}`,
      status: r.status,
      updatedAt: r.updatedAt,
    })),
    queuedCount,
    recentFailures: recentFailuresRows.map((r) => ({
      id: r.id,
      type: r.type,
      failureKind: r.failureKind,
      failureReason: truncate(r.failureReason, FAILURE_REASON_TRUNC),
      finishedAt: r.finishedAt,
    })),
    runnerHealth,
  };
}
