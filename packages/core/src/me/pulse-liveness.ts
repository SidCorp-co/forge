import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { issues, jobs, projects, runners } from '../db/schema.js';
import { formatIssueRef } from '../lib/issue-ref.js';
import { utcDayText } from '../lib/time-buckets.js';
import { ageSeconds, fillHeartbeat } from './pulse-folds.js';
import { idList } from './pulse-sql.js';
import {
  PULSE_HEARTBEAT_DAYS,
  PULSE_LIVE_JOB_STATUSES,
  type PulseJobIdentity,
  type PulseLiveness,
  type PulseRunIdentity,
  type PulseThresholds,
} from './pulse-types.js';

const LIVE = [...PULSE_LIVE_JOB_STATUSES];

/** One row per live-job status, and zero for a status nothing holds. */
async function countJobsByStatus(projectIds: string[]): Promise<Record<string, number>> {
  const rows = await db
    .select({ status: jobs.status, n: sql<number>`count(*)::int` })
    .from(jobs)
    .where(and(inArray(jobs.projectId, projectIds), inArray(jobs.status, LIVE)))
    .groupBy(jobs.status);
  const out: Record<string, number> = {};
  for (const r of rows) out[r.status] = Number(r.n);
  return out;
}

async function selectLiveJobs(
  projectIds: string[],
  cap: number,
  now: Date,
): Promise<PulseJobIdentity[]> {
  const rows = await db
    .select({
      jobId: jobs.id,
      runId: jobs.pipelineRunId,
      type: jobs.type,
      projectSlug: projects.slug,
      issuePrefix: projects.issuePrefix,
      issSeq: issues.issSeq,
      issueDocId: issues.id,
      since: sql<string>`coalesce(${jobs.dispatchedAt}, ${jobs.queuedAt})`,
    })
    .from(jobs)
    .innerJoin(projects, eq(projects.id, jobs.projectId))
    .leftJoin(issues, eq(issues.id, jobs.issueId))
    .where(and(inArray(jobs.projectId, projectIds), inArray(jobs.status, LIVE)))
    .orderBy(sql`coalesce(${jobs.dispatchedAt}, ${jobs.queuedAt}) ASC`)
    .limit(cap);
  return rows.map((r) => ({
    jobId: r.jobId,
    runId: r.runId,
    type: r.type,
    projectSlug: r.projectSlug,
    issueRef: r.issSeq == null ? null : formatIssueRef(r.issuePrefix, r.issSeq),
    issueDocId: r.issueDocId ?? null,
    ageSeconds: ageSeconds(r.since, now) ?? 0,
  }));
}

/**
 * Runs the control plane still calls open that nothing is working.
 */
async function selectStuckRuns(
  projectIds: string[],
  cap: number,
  now: Date,
): Promise<{ total: number; shown: PulseRunIdentity[] }> {
  const scope = idList(projectIds);
  const live = idList(LIVE);
  const [{ n = 0 } = { n: 0 }] = (await db.execute(sql`
    SELECT count(*)::int AS n
    FROM pipeline_runs r
    WHERE r.project_id IN (${scope})
      AND r.status IN ('running', 'paused')
      AND NOT EXISTS (
        SELECT 1 FROM jobs j WHERE j.pipeline_run_id = r.id AND j.status IN (${live})
      )
  `)) as unknown as Array<{ n: number }>;

  const rows = (await db.execute(sql`
    SELECT r.id AS run_id, p.slug AS project_slug, p.issue_prefix, i.iss_seq, i.id AS issue_doc_id, r.started_at
    FROM pipeline_runs r
    JOIN projects p ON p.id = r.project_id
    LEFT JOIN issues i ON i.id = r.issue_id
    WHERE r.project_id IN (${scope})
      AND r.status IN ('running', 'paused')
      AND NOT EXISTS (
        SELECT 1 FROM jobs j WHERE j.pipeline_run_id = r.id AND j.status IN (${live})
      )
    ORDER BY r.started_at ASC
    LIMIT ${cap}
  `)) as unknown as Array<{
    run_id: string;
    project_slug: string;
    issue_prefix: string | null;
    iss_seq: number | null;
    issue_doc_id: string | null;
    started_at: string;
  }>;

  return {
    total: Number(n),
    shown: rows.map((r) => ({
      runId: r.run_id,
      projectSlug: r.project_slug,
      issueRef: r.iss_seq == null ? null : formatIssueRef(r.issue_prefix, r.iss_seq),
      issueDocId: r.issue_doc_id,
      ageSeconds: ageSeconds(r.started_at, now) ?? 0,
    })),
  };
}

/** The newest moment any job in scope did anything, or null where none has. */
async function readLastJobAt(projectIds: string[]): Promise<string | null> {
  const [row] = (await db.execute(sql`
    SELECT max(coalesce(finished_at, acked_at, dispatched_at, queued_at)) AS last_at
    FROM jobs WHERE project_id IN (${idList(projectIds)})
  `)) as unknown as Array<{ last_at: string | null }>;
  return row?.last_at ?? null;
}

async function readHeartbeat(projectIds: string[], now: Date) {
  const rows = (await db.execute(sql`
    SELECT ${utcDayText(sql`started_at`)} AS day,
           count(*)::int AS n
    FROM pipeline_runs
    WHERE project_id IN (${idList(projectIds)})
      AND kind = 'issue'
      AND started_at >= now() - (${PULSE_HEARTBEAT_DAYS}::int * interval '1 day')
    GROUP BY 1
  `)) as unknown as Array<{ day: string; n: number }>;
  return fillHeartbeat(new Map(rows.map((r) => [r.day, Number(r.n)])), now);
}

async function readRunners(projectIds: string[]) {
  const rows = await db
    .select({ status: runners.status, n: sql<number>`count(*)::int` })
    .from(runners)
    .where(inArray(runners.projectId, projectIds))
    .groupBy(runners.status);
  let online = 0;
  let draining = 0;
  let total = 0;
  for (const r of rows) {
    const n = Number(r.n);
    total += n;
    if (r.status === 'online') online = n;
    if (r.status === 'draining') draining = n;
  }
  return { online, draining, total };
}

export async function readPulseLiveness(
  projectIds: string[],
  thresholds: PulseThresholds,
  now: Date,
): Promise<PulseLiveness> {
  const cap = thresholds.identityCap;
  const [byStatus, liveJobs, stuckRuns, lastJobAt, heartbeat, runnerCounts] = await Promise.all([
    countJobsByStatus(projectIds),
    selectLiveJobs(projectIds, cap, now),
    selectStuckRuns(projectIds, cap, now),
    readLastJobAt(projectIds),
    readHeartbeat(projectIds, now),
    readRunners(projectIds),
  ]);

  const running = (byStatus.running ?? 0) + (byStatus.dispatched ?? 0);
  return {
    jobsRunning: running,
    jobsQueued: byStatus.queued ?? 0,
    jobsHeld: byStatus.held ?? 0,
    liveJobs: { total: running + (byStatus.queued ?? 0) + (byStatus.held ?? 0), shown: liveJobs },
    stuckRuns,
    lastJobAt,
    silenceSeconds: ageSeconds(lastJobAt, now),
    heartbeat,
    devices: runnerCounts,
  };
}
