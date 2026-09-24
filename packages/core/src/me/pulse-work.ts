import { and, inArray, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { issues } from '../db/schema.js';
import { HUMAN_PARK_STATUSES } from '../issues/status-sets.js';
import { LIVE_JOB_STATUSES } from '../jobs/status-sets.js';
import { formatIssueRef } from '../lib/issue-ref.js';
import { ageSeconds, emptyBuckets, foldBuckets } from './pulse-folds.js';
import { readPulseLive } from './pulse-live.js';
import { idList } from './pulse-sql.js';
import type {
  PulseIssueIdentity,
  PulseProjectIdentity,
  PulseProjectRow,
  PulseThresholds,
  PulseWork,
} from './pulse-types.js';

const LIVE = [...LIVE_JOB_STATUSES];

/**
 * Issues the tracker calls in flight that nothing is working.
 */
async function selectAbandoned(
  projectIds: string[],
  thresholds: PulseThresholds,
  now: Date,
): Promise<{ total: number; shown: PulseIssueIdentity[]; byProject: Map<string, number> }> {
  const [row] = (await db.execute(sql`
    WITH stale AS (
      SELECT i.id, i.iss_seq, i.title, i.status, i.project_id,
             p.slug AS project_slug, p.issue_prefix,
             coalesce(
               (SELECT max(seen) FROM (
                  SELECT max(coalesce(j.finished_at, j.acked_at, j.dispatched_at, j.queued_at)) AS seen
                  FROM jobs j WHERE j.issue_id = i.id
                  UNION ALL
                  SELECT max(coalesce(j.finished_at, j.acked_at, j.dispatched_at, j.queued_at))
                  FROM jobs j JOIN pipeline_runs r ON r.id = j.pipeline_run_id
                  WHERE r.issue_id = i.id
                ) arms),
               i.updated_at
             ) AS idle_since
      FROM issues i
      JOIN projects p ON p.id = i.project_id
      WHERE i.project_id IN (${idList(projectIds)})
        AND i.status = 'in_progress'
        AND NOT EXISTS (
          SELECT 1 FROM jobs j
          WHERE j.issue_id = i.id AND j.status IN (${idList(LIVE)})
          UNION ALL
          SELECT 1 FROM jobs j JOIN pipeline_runs r ON r.id = j.pipeline_run_id
          WHERE r.issue_id = i.id AND j.status IN (${idList(LIVE)})
        )
    -- the age this read reports is measured against that same value in ageSeconds below: a
    -- row the SQL called stale against one clock and the fold ages against another is a row
    -- whose reported age can disagree with the reason it was selected. That now is injectable
    -- so the integration suite can place a fixture either side of the threshold deliberately.
    -- The ISO text is cast rather than bound as a Date, which postgres-js refuses (ISS-267).
    ), aged AS (
      SELECT * FROM stale
      WHERE idle_since < ${now.toISOString()}::timestamptz
                         - (${thresholds.abandonedIssueSeconds}::int * interval '1 second')
    )
    SELECT
      (SELECT count(*)::int FROM aged) AS total,
      (SELECT coalesce(jsonb_object_agg(project_id, n), '{}'::jsonb)
         FROM (SELECT project_id, count(*)::int AS n FROM aged GROUP BY project_id) g) AS by_project,
      (SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.idle_since ASC), '[]'::jsonb)
         FROM (SELECT * FROM aged ORDER BY idle_since ASC LIMIT ${thresholds.identityCap}) t) AS shown
  `)) as unknown as Array<{
    total: number;
    by_project: Record<string, number>;
    shown: Array<{
      id: string;
      iss_seq: number;
      title: string;
      status: string;
      project_slug: string;
      issue_prefix: string | null;
      idle_since: string;
    }>;
  }>;

  const byProject = new Map<string, number>();
  for (const [projectId, n] of Object.entries(row?.by_project ?? {})) {
    byProject.set(projectId, Number(n));
  }

  return {
    total: Number(row?.total ?? 0),
    byProject,
    shown: (row?.shown ?? []).map((r) => ({
      documentId: r.id,
      issueRef: formatIssueRef(r.issue_prefix, r.iss_seq),
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
  const [row] = (await db.execute(sql`
    WITH waiting AS (
      SELECT i.id, i.iss_seq, i.title, i.status, i.updated_at,
             p.slug AS project_slug, p.issue_prefix
      FROM issues i JOIN projects p ON p.id = i.project_id
      WHERE i.project_id IN (${idList(projectIds)})
        AND i.status IN ('awaiting_release', 'releasing')
        AND i.updated_at < ${now.toISOString()}::timestamptz
                           - (${thresholds.releaseWaitingSeconds}::int * interval '1 second')
    )
    SELECT
      (SELECT count(*)::int FROM waiting) AS total,
      (SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.updated_at ASC), '[]'::jsonb)
         FROM (SELECT * FROM waiting ORDER BY updated_at ASC LIMIT ${thresholds.identityCap}) t) AS shown
  `)) as unknown as Array<{
    total: number;
    shown: Array<{
      id: string;
      iss_seq: number;
      title: string;
      status: string;
      updated_at: string;
      project_slug: string;
      issue_prefix: string | null;
    }>;
  }>;
  return {
    total: Number(row?.total ?? 0),
    shown: (row?.shown ?? []).map((r) => ({
      documentId: r.id,
      issueRef: formatIssueRef(r.issue_prefix, r.iss_seq),
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
      and(inArray(issues.projectId, projectIds), inArray(issues.status, [...HUMAN_PARK_STATUSES])),
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
  const [statusRows, abandoned, releaseWaiting, humanBlockedAges, runRows, live] =
    await Promise.all([
      db
        .select({
          projectId: issues.projectId,
          status: issues.status,
          n: sql<number>`count(*)::int`,
        })
        .from(issues)
        .where(inArray(issues.projectId, projectIds))
        .groupBy(issues.projectId, issues.status),
      selectAbandoned(projectIds, thresholds, now),
      selectReleaseWaiting(projectIds, thresholds, now),
      selectHumanBlockedAges(projectIds, thresholds.identityCap, now),
      selectProjectRuns(projectIds),
      readPulseLive(projectIds, thresholds, now),
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
    notOnLive: live.notOnLive,
    liveUnmeasured: live.liveUnmeasured,
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
