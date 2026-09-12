import { and, inArray, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { issues } from '../db/schema.js';
import { ageSeconds, emptyBuckets, foldBuckets } from './pulse-folds.js';
import { idList } from './pulse-sql.js';
import {
  PULSE_HUMAN_BLOCKED_STATUSES,
  PULSE_LIVE_JOB_STATUSES,
  type PulseIssueIdentity,
  type PulseProjectIdentity,
  type PulseProjectRow,
  type PulseThresholds,
  type PulseWork,
} from './pulse-types.js';

const LIVE = [...PULSE_LIVE_JOB_STATUSES];

/**
 * Issues the tracker calls in flight that nothing is working.
 */
// cm:guard the idle clock falls back to `issues.updated_at` where the issue has NEVER carried a job: comparing against a null max drops exactly the strongest case, an `in_progress` row nothing ever dispatched (ISS-988 criterion 12).
async function selectAbandoned(
  projectIds: string[],
  thresholds: PulseThresholds,
  now: Date,
): Promise<{ total: number; shown: PulseIssueIdentity[]; byProject: Map<string, number> }> {
  const rows = (await db.execute(sql`
    SELECT i.id, i.iss_seq, i.title, i.status, i.project_id, p.slug AS project_slug,
           coalesce(
             (SELECT max(coalesce(j.finished_at, j.acked_at, j.dispatched_at, j.queued_at))
              FROM jobs j WHERE j.issue_id = i.id),
             i.updated_at
           ) AS idle_since
    FROM issues i
    JOIN projects p ON p.id = i.project_id
    WHERE i.project_id IN (${idList(projectIds)})
      AND i.status = 'in_progress'
      AND NOT EXISTS (
        SELECT 1 FROM jobs j WHERE j.issue_id = i.id AND j.status IN (${idList(LIVE)})
      )
    ORDER BY idle_since ASC
  `)) as unknown as Array<{
    id: string;
    iss_seq: number;
    title: string;
    status: string;
    project_id: string;
    project_slug: string;
    idle_since: string;
  }>;

  const stale = rows.filter(
    (r) => (ageSeconds(r.idle_since, now) ?? 0) > thresholds.abandonedIssueSeconds,
  );
  const byProject = new Map<string, number>();
  for (const r of stale) byProject.set(r.project_id, (byProject.get(r.project_id) ?? 0) + 1);

  return {
    total: stale.length,
    byProject,
    shown: stale.slice(0, thresholds.identityCap).map((r) => ({
      documentId: r.id,
      issueRef: `ISS-${r.iss_seq}`,
      title: r.title,
      status: r.status,
      projectSlug: r.project_slug,
      ageSeconds: ageSeconds(r.idle_since, now) ?? 0,
    })),
  };
}

async function selectReleaseWaiting(
  projectIds: string[],
  thresholds: PulseThresholds,
  now: Date,
): Promise<{ total: number; shown: PulseIssueIdentity[] }> {
  const rows = (await db.execute(sql`
    SELECT i.id, i.iss_seq, i.title, i.status, i.updated_at, p.slug AS project_slug
    FROM issues i JOIN projects p ON p.id = i.project_id
    WHERE i.project_id IN (${idList(projectIds)})
      AND i.status IN ('awaiting_release', 'releasing')
      AND i.updated_at < now() - (${thresholds.releaseWaitingSeconds}::int * interval '1 second')
    ORDER BY i.updated_at ASC
  `)) as unknown as Array<{
    id: string;
    iss_seq: number;
    title: string;
    status: string;
    updated_at: string;
    project_slug: string;
  }>;
  return {
    total: rows.length,
    shown: rows.slice(0, thresholds.identityCap).map((r) => ({
      documentId: r.id,
      issueRef: `ISS-${r.iss_seq}`,
      title: r.title,
      status: r.status,
      projectSlug: r.project_slug,
      ageSeconds: ageSeconds(r.updated_at, now) ?? 0,
    })),
  };
}

async function selectHumanBlockedAges(
  projectIds: string[],
  cap: number,
  now: Date,
): Promise<number[]> {
  const rows = await db
    .select({ updatedAt: issues.updatedAt })
    .from(issues)
    .where(
      and(
        inArray(issues.projectId, projectIds),
        inArray(issues.status, [...PULSE_HUMAN_BLOCKED_STATUSES]),
      ),
    )
    .orderBy(sql`${issues.updatedAt} ASC`)
    .limit(cap * 10);
  return rows.map((r) => ageSeconds(r.updatedAt, now) ?? 0);
}

async function selectProjectRuns(projectIds: string[]) {
  const rows = (await db.execute(sql`
    SELECT p.id, p.slug, p.name,
           (SELECT max(r.started_at) FROM pipeline_runs r
             WHERE r.project_id = p.id AND r.kind = 'issue') AS last_issue_run_at,
           (SELECT count(*)::int FROM pipeline_runs r
             WHERE r.project_id = p.id AND r.status IN ('running','paused')
               AND NOT EXISTS (
                 SELECT 1 FROM jobs j WHERE j.pipeline_run_id = r.id AND j.status IN (${idList(LIVE)})
               )) AS stuck_runs
    FROM projects p
    WHERE p.id IN (${idList(projectIds)})
  `)) as unknown as Array<{
    id: string;
    slug: string;
    name: string;
    last_issue_run_at: string | null;
    stuck_runs: number;
  }>;
  return rows;
}

const asIdentity = (r: PulseProjectRow): PulseProjectIdentity => ({
  id: r.id,
  slug: r.slug,
  name: r.name,
  backlog: r.open + r.inProgress + r.awaitingRelease + r.humanBlocked,
  lastIssueRunAt: r.lastIssueRunAt,
});

export async function readPulseWork(
  projectIds: string[],
  thresholds: PulseThresholds,
  now: Date,
): Promise<PulseWork> {
  const [statusRows, abandoned, releaseWaiting, humanBlockedAges, runRows] = await Promise.all([
    db
      .select({ projectId: issues.projectId, status: issues.status, n: sql<number>`count(*)::int` })
      .from(issues)
      .where(inArray(issues.projectId, projectIds))
      .groupBy(issues.projectId, issues.status),
    selectAbandoned(projectIds, thresholds, now),
    selectReleaseWaiting(projectIds, thresholds, now),
    selectHumanBlockedAges(projectIds, thresholds.identityCap, now),
    selectProjectRuns(projectIds),
  ]);

  const { total, byProject } = foldBuckets(
    statusRows.map((r) => ({ projectId: r.projectId, status: r.status, n: Number(r.n) })),
  );

  const perProject: PulseProjectRow[] = runRows.map((r) => ({
    id: r.id,
    slug: r.slug,
    name: r.name,
    ...(byProject.get(r.id) ?? emptyBuckets()),
    stuckRuns: Number(r.stuck_runs),
    abandonedIssues: abandoned.byProject.get(r.id) ?? 0,
    lastIssueRunAt: r.last_issue_run_at,
  }));

  const backlogged = perProject.filter(
    (p) => p.open + p.inProgress + p.awaitingRelease + p.humanBlocked > 0,
  );
  const neverRan = backlogged.filter((p) => p.lastIssueRunAt === null);
  const silent = backlogged.filter(
    (p) =>
      p.lastIssueRunAt !== null &&
      (ageSeconds(p.lastIssueRunAt, now) ?? 0) > thresholds.projectSilenceSeconds,
  );

  return {
    buckets: total,
    abandoned: { total: abandoned.total, shown: abandoned.shown },
    releaseWaiting,
    silentProjects: {
      total: silent.length,
      shown: silent.slice(0, thresholds.identityCap).map(asIdentity),
    },
    neverRanProjects: {
      total: neverRan.length,
      shown: neverRan.slice(0, thresholds.identityCap).map(asIdentity),
    },
    humanBlockedAges,
    perProject,
  };
}
