import { and, asc, count, desc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db/client.js';
import { issues, jobs, runners } from '../../db/schema.js';
import {
  type DeviceScopedMcpToolFactory,
  assertDeviceOwnerIsMember,
  zodToMcpSchema,
} from './lib.js';

/**
 * `forge_pm.snapshot` (Epic 3, ISS-19) — compact project-state digest the PM
 * agent loads at the start of every decision turn. Six independent reads
 * keyed on `project_id` and trimmed to a small, predictable payload (target
 * < 2 KB JSON for a typical project) so the digest fits inside the agent's
 * priming context without crowding out memory excerpts.
 */

const inputSchema = z.object({ projectId: z.uuid() }).strict();

const ACTIVE_JOB_STATUSES = ['queued', 'dispatched', 'running'] as const;
const ACTIVE_PIPELINE_STATUSES = [
  'approved',
  'in_progress',
  'developed',
  'deploying',
  'testing',
] as const;

const FAILURE_REASON_TRUNC = 200;

function truncate(value: string | null, max: number): string | null {
  if (!value) return value;
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

export const forgePmSnapshotTool: DeviceScopedMcpToolFactory = (device) => ({
  name: 'forge_pm.snapshot',
  description:
    'Compact project-state digest for the PM agent: counts by status, active jobs, stalled issues, queued count, recent failures, runner health. Read-only; requires project membership.',
  inputSchema: zodToMcpSchema(inputSchema),
  handler: async (args) => {
    const input = inputSchema.parse(args);
    await assertDeviceOwnerIsMember(device, input.projectId);

    const countsRows = await db
      .select({ status: issues.status, n: count() })
      .from(issues)
      .where(eq(issues.projectId, input.projectId))
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
      .where(
        and(
          eq(jobs.projectId, input.projectId),
          inArray(jobs.status, [...ACTIVE_JOB_STATUSES]),
        ),
      )
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
          eq(issues.projectId, input.projectId),
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
      .where(and(eq(jobs.projectId, input.projectId), eq(jobs.status, 'queued')));
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
      .where(and(eq(jobs.projectId, input.projectId), eq(jobs.status, 'failed')))
      .orderBy(desc(jobs.finishedAt))
      .limit(5);

    const runnerRows = await db
      .select({
        id: runners.id,
        type: runners.type,
        status: runners.status,
        lastSeenAt: runners.lastSeenAt,
      })
      .from(runners)
      .where(eq(runners.projectId, input.projectId));

    const runnerHealth = await Promise.all(
      runnerRows.map(async (r) => {
        const [row] = await db
          .select({ n: count() })
          .from(jobs)
          .where(and(eq(jobs.runnerId, r.id), inArray(jobs.status, ['dispatched', 'running'])));
        return {
          id: r.id,
          type: r.type,
          status: r.status,
          lastSeenAt: r.lastSeenAt,
          inFlight: Number(row?.n ?? 0),
        };
      }),
    );

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
  },
});

