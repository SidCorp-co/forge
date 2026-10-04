import { NON_OPEN_STATUSES } from '@forge/contracts/issue-machine';
import { UNHELD_LIVE_JOB_STATUSES } from '@forge/contracts/job-machine';
import { and, count, desc, eq, ilike, inArray, isNull, sql } from 'drizzle-orm';
import { readThresholds } from '../admin-thresholds/index.js';
import { db } from '../db/client.js';
import {
  activityLog,
  type DeviceStatus,
  devices,
  issues,
  jobs,
  organizations,
  pipelineRuns,
  projectMembers,
  projects,
  usageRecords,
  users,
} from '../db/schema.js';
import { sqlTimestamp } from '../db/sql-timestamp.js';
import { buildIlikePattern } from '../issues/index.js';
import { utcDateTrunc } from '../lib/time-buckets.js';
import { computeAlerts } from './alert-queries.js';
import {
  type BucketUnit,
  bucketBoundaries,
  computeSeries,
  createRawLoaders,
  cutoffExpr,
  METRIC_SOURCES,
  toBucketMap,
  toGlance,
  WINDOW_SPECS,
} from './metric-series.js';
import {
  type AdminAdoptionBucket,
  type AdminGlanceMetric,
  type AdminGlanceMetricName,
  type AdminOverview,
  type AdminWorkspaceRow,
  GLANCE_METRIC_NAMES,
  type GLANCE_WINDOWS,
} from './types.js';

type GlanceWindow = (typeof GLANCE_WINDOWS)[number];

/** A page of rows and the total the filter matched. */
type AdminPage<T> = { rows: T[]; total: number };

/** The Ops Console overview: tenant counts, KPIs and the glance metrics for `window`. */
export async function readAdminOverview(window: GlanceWindow): Promise<AdminOverview> {
  const spec = WINDOW_SPECS[window];
  const now = new Date();
  const thresholds = await readThresholds();
  const openAlerts = (await computeAlerts({ now, thresholds })).filter(
    (a) => a.status !== 'ok',
  ).length;
  const cutoff = cutoffExpr(spec.hours);
  const baseStart = cutoffExpr(spec.hours * 2);
  const raw = createRawLoaders(spec, baseStart, thresholds.interventionLabels);

  const [
    [{ n: usersTotal } = { n: 0 }],
    [{ n: orgsTotal } = { n: 0 }],
    [{ n: projectsTotal } = { n: 0 }],
    [{ n: activeWorkspaces } = { n: 0 }],
    [{ n: devicesOnline } = { n: 0 }],
    [{ n: devicesTotal } = { n: 0 }],
    [{ n: inFlightJobs } = { n: 0 }],
    [{ v: spendWindowUsd } = { v: 0 }],
    [{ v: spendBaselineUsd } = { v: 0 }],
    glanceEntries,
  ] = await Promise.all([
    db.select({ n: count() }).from(users),
    db.select({ n: count() }).from(organizations),
    db.select({ n: count() }).from(projects).where(isNull(projects.archivedAt)),
    db
      .select({ n: sql<number>`count(distinct ${pipelineRuns.projectId})::int` })
      .from(pipelineRuns)
      .where(sql`${pipelineRuns.startedAt} >= ${cutoff}`),
    db.select({ n: count() }).from(devices).where(eq(devices.status, 'online')),
    db.select({ n: count() }).from(devices),
    db
      .select({ n: count() })
      .from(jobs)
      .where(inArray(jobs.status, [...UNHELD_LIVE_JOB_STATUSES])),
    db
      .select({ v: sql<number>`coalesce(sum(${usageRecords.estimatedCost}), 0)::float` })
      .from(usageRecords)
      .where(sql`${usageRecords.recordedAt} >= ${cutoff}`),
    db
      .select({ v: sql<number>`coalesce(sum(${usageRecords.estimatedCost}), 0)::float` })
      .from(usageRecords)
      .where(
        sql`${usageRecords.recordedAt} >= ${baseStart} AND ${usageRecords.recordedAt} < ${cutoff}`,
      ),
    Promise.all(
      GLANCE_METRIC_NAMES.map(
        async (name) =>
          [name, toGlance(computeSeries(await METRIC_SOURCES[name](raw), spec, now))] as const,
      ),
    ),
  ]);

  const glance = Object.fromEntries(glanceEntries) as Record<
    AdminGlanceMetricName,
    AdminGlanceMetric
  >;

  return {
    counts: {
      users: Number(usersTotal),
      usersNew: glance.signupsWindow.value ?? 0,
      orgs: Number(orgsTotal),
      projects: Number(projectsTotal),
      activeWorkspaces: Number(activeWorkspaces),
      devicesOnline: Number(devicesOnline),
      devicesTotal: Number(devicesTotal),
    },
    kpis: {
      openAlerts,
      inFlightJobs: Number(inFlightJobs),
      spendWindowUsd: Number(spendWindowUsd),
      spendBaselineUsd: Number(spendBaselineUsd),
    },
    glance,
  };
}

/** New and cumulative users and active workspaces per bucket over the last `weeks`. */
export async function readAdminAdoption(
  weeks: number,
  bucket: BucketUnit,
): Promise<AdminAdoptionBucket[]> {
  const now = new Date();
  const bucketCount = bucket === 'week' ? weeks : weeks * 7;
  const buckets = bucketBoundaries(bucket, bucketCount, now);
  const firstBucketStart = buckets[0] as string;

  const [newUsersRows, activeWorkspaceRows, [{ n: baselineUsers } = { n: 0 }]] = await Promise.all([
    db.execute(sql`
        SELECT ${utcDateTrunc(bucket, sql`created_at`)} AS bucket, count(*)::int AS n
        FROM users
        WHERE created_at >= ${firstBucketStart}::timestamptz
        GROUP BY 1
      `) as unknown as Promise<Array<{ bucket: unknown; n: number }>>,
    db.execute(sql`
        SELECT ${utcDateTrunc(bucket, sql`started_at`)} AS bucket, count(distinct project_id)::int AS n
        FROM pipeline_runs
        WHERE started_at >= ${firstBucketStart}::timestamptz
        GROUP BY 1
      `) as unknown as Promise<Array<{ bucket: unknown; n: number }>>,
    db
      .select({ n: count() })
      .from(users)
      .where(sql`${users.createdAt} < ${firstBucketStart}::timestamptz`),
  ]);

  const newUsersByBucket = toBucketMap(newUsersRows, 'n');
  const activeWorkspacesByBucket = toBucketMap(activeWorkspaceRows, 'n');

  let cumulative = Number(baselineUsers);
  return buckets.map((bucketStart) => {
    const newUsers = newUsersByBucket.get(bucketStart) ?? 0;
    cumulative += newUsers;
    return {
      bucketStart,
      newUsers,
      cumulativeUsers: cumulative,
      activeWorkspaces: activeWorkspacesByBucket.get(bucketStart) ?? 0,
    };
  });
}

type AdminWorkspaceSort = 'runs' | 'spend' | 'leadTime';

/** Every live project's runs, spend, median lead time and open issues in `window`, sorted. */
export async function readAdminWorkspaces(
  window: GlanceWindow,
  sort: AdminWorkspaceSort,
  limit: number,
): Promise<AdminPage<AdminWorkspaceRow>> {
  const cutoff = cutoffExpr(WINDOW_SPECS[window].hours);

  const [allProjects, runRows, spendRows, leadTimeRows, openIssueRows] = await Promise.all([
    db
      .select({ id: projects.id, slug: projects.slug })
      .from(projects)
      .where(isNull(projects.archivedAt)),
    db.execute(sql`
      SELECT project_id, count(*)::int AS n
      FROM pipeline_runs
      WHERE started_at >= ${cutoff}
      GROUP BY 1
    `) as unknown as Promise<Array<{ project_id: string; n: number }>>,
    db.execute(sql`
      SELECT project_id, coalesce(sum(estimated_cost), 0)::float AS n
      FROM usage_records
      WHERE recorded_at >= ${cutoff} AND project_id IS NOT NULL
      GROUP BY 1
    `) as unknown as Promise<Array<{ project_id: string; n: number }>>,
    db.execute(sql`
      SELECT i.project_id AS project_id,
             percentile_disc(0.5) WITHIN GROUP (
               ORDER BY extract(epoch from (al.created_at - i.created_at)) / 60.0
             )::float AS n
      FROM activity_log al
      INNER JOIN issues i ON i.id = al.issue_id
      WHERE al.action = 'issue.statusChanged'
        AND al.payload ->> 'to' IN ('in_progress', 'approved')
        AND al.created_at = (
          SELECT min(al2.created_at) FROM activity_log al2
          WHERE al2.issue_id = al.issue_id
            AND al2.action = 'issue.statusChanged'
            AND al2.payload ->> 'to' IN ('in_progress', 'approved')
        )
        AND al.created_at >= ${cutoff}
      GROUP BY 1
    `) as unknown as Promise<Array<{ project_id: string; n: number | null }>>,
    db
      .select({ projectId: issues.projectId, n: count() })
      .from(issues)
      .where(
        sql`${issues.status} NOT IN (${sql.join(
          [...NON_OPEN_STATUSES].map((s) => sql`${s}`),
          sql`, `,
        )})`,
      )
      .groupBy(issues.projectId),
  ]);

  const runsByProject = new Map(runRows.map((r) => [r.project_id, Number(r.n)]));
  const spendByProject = new Map(spendRows.map((r) => [r.project_id, Number(r.n)]));
  const leadTimeByProject = new Map(
    leadTimeRows.map((r) => [r.project_id, r.n == null ? null : Number(r.n)]),
  );
  const openIssuesByProject = new Map(openIssueRows.map((r) => [r.projectId, Number(r.n)]));

  const rows: AdminWorkspaceRow[] = allProjects.map((p) => ({
    projectId: p.id,
    slug: p.slug,
    runs: runsByProject.get(p.id) ?? 0,
    spendUsd: spendByProject.get(p.id) ?? 0,
    medianLeadTimeMin: leadTimeByProject.get(p.id) ?? null,
    openIssues: openIssuesByProject.get(p.id) ?? 0,
  }));

  const sortKey: Record<AdminWorkspaceSort, (r: AdminWorkspaceRow) => number> = {
    runs: (r) => r.runs,
    spend: (r) => r.spendUsd,
    leadTime: (r) => r.medianLeadTimeMin ?? -1,
  };
  rows.sort((a, b) => sortKey[sort](b) - sortKey[sort](a));

  return { rows: rows.slice(0, limit), total: allProjects.length };
}

type PageQuery = { limit: number; offset: number };

/** Users, newest first, optionally narrowed by an email search. */
export async function listAdminUsers({ limit, offset, q }: PageQuery & { q?: string | undefined }) {
  const where = q ? ilike(users.email, buildIlikePattern(q)) : undefined;
  const [{ n } = { n: 0 }] = await db.select({ n: count() }).from(users).where(where);
  const rows = await db
    .select({
      id: users.id,
      email: users.email,
      emailVerifiedAt: users.emailVerifiedAt,
      createdAt: users.createdAt,
    })
    .from(users)
    .where(where)
    .orderBy(desc(users.createdAt))
    .limit(limit)
    .offset(offset);
  return { rows, total: Number(n) };
}

/** Projects, newest first, with creator email and member count, optionally narrowed by slug or name. */
export async function listAdminProjects({
  limit,
  offset,
  q,
}: PageQuery & { q?: string | undefined }) {
  const pattern = q ? buildIlikePattern(q) : undefined;
  const where = pattern
    ? sql`${projects.slug} ILIKE ${pattern} ESCAPE '\\' OR ${projects.name} ILIKE ${pattern} ESCAPE '\\'`
    : undefined;
  const [{ n } = { n: 0 }] = await db.select({ n: count() }).from(projects).where(where);

  const memberCountSq = db
    .select({
      projectId: projectMembers.projectId,
      n: count().as('member_count'),
    })
    .from(projectMembers)
    .groupBy(projectMembers.projectId)
    .as('mc');

  const rows = await db
    .select({
      id: projects.id,
      slug: projects.slug,
      name: projects.name,
      createdBy: projects.createdBy,
      creatorEmail: users.email,
      memberCount: memberCountSq.n,
      createdAt: projects.createdAt,
    })
    .from(projects)
    .leftJoin(users, eq(users.id, projects.createdBy))
    .leftJoin(memberCountSq, eq(memberCountSq.projectId, projects.id))
    .where(where)
    .orderBy(desc(projects.createdAt))
    .limit(limit)
    .offset(offset);

  return {
    rows: rows.map((r) => ({ ...r, memberCount: Number(r.memberCount ?? 0) })),
    total: Number(n),
  };
}

/** Devices, newest first, optionally narrowed by status. */
export async function listAdminDevices({
  limit,
  offset,
  status,
}: PageQuery & { status?: DeviceStatus | undefined }) {
  const where = status ? eq(devices.status, status) : undefined;
  const [{ n } = { n: 0 }] = await db.select({ n: count() }).from(devices).where(where);
  const rows = await db
    .select()
    .from(devices)
    .where(where)
    .orderBy(desc(devices.createdAt))
    .limit(limit)
    .offset(offset);
  return { rows, total: Number(n) };
}

/** Activity log entries, newest first, narrowed by action, actor and start time. */
export async function listAdminAudit({
  limit,
  offset,
  action,
  actorId,
  since,
}: PageQuery & {
  action?: string | undefined;
  actorId?: string | undefined;
  since?: Date | undefined;
}) {
  const where: ReturnType<typeof and>[] = [];
  if (action) where.push(eq(activityLog.action, action));
  if (actorId) where.push(eq(activityLog.actorId, actorId));
  if (since) where.push(sql`${activityLog.createdAt} >= ${sqlTimestamp(since)}`);
  const whereExpr = where.length === 0 ? undefined : where.length === 1 ? where[0] : and(...where);

  const [{ n } = { n: 0 }] = await db.select({ n: count() }).from(activityLog).where(whereExpr);
  const rows = await db
    .select()
    .from(activityLog)
    .where(whereExpr)
    .orderBy(desc(activityLog.createdAt))
    .limit(limit)
    .offset(offset);
  return { rows, total: Number(n) };
}
