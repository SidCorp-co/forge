import { and, eq, inArray, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { db } from '../db/client.js';
import {
  activityLog,
  issues,
  pipelineRuns,
  projectMembers,
  projects,
  runners,
  users,
} from '../db/schema.js';
import { loadVisibleProjectIds } from '../lib/authz.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';

interface ProjectHealthRow {
  /** Project UUID — needed by web-v2 to join the `GET /api/projects` list rows
   *  (which carry `id` but no metrics) against this health rollup. */
  id: string;
  projectName: string;
  projectSlug: string;
  projectMeta: Record<string, unknown>;
  /** Free-text description (nullable in the DB → `null` here). */
  description: string | null;
  /** Repo path/slug shown under the project name (nullable). */
  repoPath: string | null;
  throughput: number;
  totalActive: number;
  statusDistribution: Record<string, number>;
  blockers: Array<{ issueId: string; documentId: string; status: string }>;
  pendingEscalations: number;
  avgCycleTimeDays: number;
  /** Pipeline runs currently `running` or `paused`. */
  liveRuns: number;
  /** Runners in the `online` state. */
  runnerCount: number;
  /** Trailing-24h spend (USD) from the `pipeline_run_step_durations` view. */
  spend24hUsd: number;
  /** True total project membership count. */
  memberCount: number;
  /** Up to 5 email-derived avatar initials (no display-name column exists). */
  members: string[];
  /** ISO timestamp of the most recent issue/run activity, or `null`. */
  lastActivityAt: string | null;
}

/** First 2 chars of the email local-part, uppercased — the avatar initials. */
function emailInitials(email: string): string {
  const local = email.split('@')[0] ?? email;
  return local.slice(0, 2).toUpperCase();
}

const MEMBER_AVATAR_CAP = 5;

const ACTIVE_STATUSES = [
  'open',
  'confirmed',
  'waiting',
  'approved',
  'in_progress',
  'developed',
  'deploying',
  'testing',
  'tested',
  'pass',
  'staging',
  'reopen',
] as const;
const BLOCKED_STATUSES = ['on_hold', 'needs_info'] as const;

export const projectHealthRoutes = new Hono<{ Variables: AuthVars }>();
projectHealthRoutes.use('/health', requireAuth(), assertEmailVerified());

projectHealthRoutes.get('/health', async (c) => {
  const userId = c.get('userId');

  // Caller sees their visible projects (explicit member OR org owner/admin).
  const visibleIds = await loadVisibleProjectIds(userId);
  if (visibleIds.length === 0) return c.json([]);
  const visibleProjects = await db
    .select({
      id: projects.id,
      slug: projects.slug,
      name: projects.name,
      agentConfig: projects.agentConfig,
      description: projects.description,
      repoPath: projects.repoPath,
    })
    .from(projects)
    .where(inArray(projects.id, visibleIds));

  if (visibleProjects.length === 0) return c.json([]);

  const projectIds = visibleProjects.map((p) => p.id);

  // Status distribution per project — single GROUP BY query.
  const statusRows = await db
    .select({
      projectId: issues.projectId,
      status: issues.status,
      n: sql<number>`count(*)::int`,
    })
    .from(issues)
    .where(inArray(issues.projectId, projectIds))
    .groupBy(issues.projectId, issues.status);

  // Blockers — issues currently on_hold or needs_info. ORDER BY (project, ts)
  // is required so the per-project cap below picks the freshest blockers
  // deterministically rather than letting one noisy project starve the rest.
  const PER_PROJECT_BLOCKER_CAP = 5;
  const blockerRowsAll = await db
    .select({
      projectId: issues.projectId,
      id: issues.id,
      issSeq: issues.issSeq,
      status: issues.status,
      updatedAt: issues.updatedAt,
    })
    .from(issues)
    .where(
      and(inArray(issues.projectId, projectIds), inArray(issues.status, [...BLOCKED_STATUSES])),
    )
    .orderBy(issues.projectId, sql`${issues.updatedAt} DESC`);

  const perProjectBlockerCount = new Map<string, number>();
  const blockerRows = blockerRowsAll.filter((r) => {
    const n = perProjectBlockerCount.get(r.projectId) ?? 0;
    if (n >= PER_PROJECT_BLOCKER_CAP) return false;
    perProjectBlockerCount.set(r.projectId, n + 1);
    return true;
  });

  // Throughput proxy = closed-or-released transitions in last 7 days.
  // The cutoff is computed in SQL (`now() - interval '7 days'`) rather than as
  // a JS Date binding because postgres-js refuses to serialize Date instances
  // through parameterized queries — it throws `ERR_INVALID_ARG_TYPE` from
  // Buffer.byteLength at Bind time. See ISS-267.
  const throughputRows = await db
    .select({
      projectId: issues.projectId,
      n: sql<number>`count(*)::int`,
    })
    .from(activityLog)
    .innerJoin(issues, eq(issues.id, activityLog.issueId))
    .where(
      and(
        inArray(issues.projectId, projectIds),
        eq(activityLog.action, 'issue.statusChanged'),
        sql`${activityLog.payload} ->> 'to' IN ('closed','released')`,
        sql`${activityLog.createdAt} >= now() - interval '7 days'`,
      ),
    )
    .groupBy(issues.projectId);

  // Avg cycle time (days) = mean(resolved_at - work_start) over issues that
  // transitioned to closed/released in the same trailing-7d window as
  // throughput. Was hardcoded 0 (ISS-308 B1: surfaced as a misleading "0d").
  // ISS-380 (AC #3): work_start is now the FIRST transition into
  // in_progress/approved (true cycle time), not issues.createdAt (which was
  // lead time from creation and overstated the number). Falls back to
  // issues.createdAt for issues that predate those transitions via COALESCE.
  // Same SQL-side `now() - interval` cutoff as throughput (postgres-js can't
  // bind a JS Date — see the throughput note above).
  const cycleRows = await db
    .select({
      projectId: issues.projectId,
      avgDays: sql<number | null>`avg(extract(epoch from (${activityLog.createdAt} - COALESCE((
        SELECT min(al2.created_at) FROM activity_log al2
        WHERE al2.issue_id = ${activityLog.issueId}
          AND al2.action = 'issue.statusChanged'
          AND al2.payload ->> 'to' IN ('in_progress','approved')
      ), ${issues.createdAt}))) / 86400.0)`,
    })
    .from(activityLog)
    .innerJoin(issues, eq(issues.id, activityLog.issueId))
    .where(
      and(
        inArray(issues.projectId, projectIds),
        eq(activityLog.action, 'issue.statusChanged'),
        sql`${activityLog.payload} ->> 'to' IN ('closed','released')`,
        sql`${activityLog.createdAt} >= now() - interval '7 days'`,
      ),
    )
    .groupBy(issues.projectId);

  // Live runs — pipeline_runs currently running or paused, per project.
  const liveRunRows = await db
    .select({
      projectId: pipelineRuns.projectId,
      n: sql<number>`count(*)::int`,
    })
    .from(pipelineRuns)
    .where(
      and(
        inArray(pipelineRuns.projectId, projectIds),
        inArray(pipelineRuns.status, ['running', 'paused']),
      ),
    )
    .groupBy(pipelineRuns.projectId);

  // Online runners per project.
  const runnerRows = await db
    .select({
      projectId: runners.projectId,
      n: sql<number>`count(*)::int`,
    })
    .from(runners)
    .where(and(inArray(runners.projectId, projectIds), eq(runners.status, 'online')))
    .groupBy(runners.projectId);

  // Trailing-24h spend from the pipeline_run_step_durations view (same source as
  // the per-project cost-summary route). One batch query over all visible
  // project ids — no per-project N+1; projectIds is non-empty here (the
  // visibleProjects.length === 0 early-return guards it).
  //
  // Build the id list as a parenthesised parameter list via `sql.join` and use
  // `IN (...)`, NOT `= ANY(${projectIds})`. Embedding a JS array directly in the
  // drizzle template expands it as a record tuple ($1, $2, ...), so `ANY(tuple)`
  // / `ANY(tuple::uuid[])` is a malformed array literal and 500s (two prior live
  // FAILs). `IN ($1, $2, ...)` makes each comparison a scalar `uuid = text`,
  // which Postgres casts implicitly — same idiom as reconciler.ts.
  const projectIdList = sql.join(
    projectIds.map((id) => sql`${id}`),
    sql`, `,
  );
  const spendRows = (await db.execute(sql`
    SELECT project_id, COALESCE(SUM(cost_usd), 0)::float AS spend
    FROM pipeline_run_step_durations
    WHERE project_id IN (${projectIdList})
      AND started_at >= now() - interval '24 hours'
    GROUP BY project_id
  `)) as unknown as Array<{ project_id: string; spend: number }>;

  // Members — fetch (projectId, email) ordered so the per-project cap below is
  // deterministic. memberCount carries the true total; `members` is capped for
  // the avatar stack.
  const memberRows = await db
    .select({
      projectId: projectMembers.projectId,
      email: users.email,
      joinedAt: projectMembers.createdAt,
    })
    .from(projectMembers)
    .innerJoin(users, eq(users.id, projectMembers.userId))
    .where(inArray(projectMembers.projectId, projectIds))
    .orderBy(projectMembers.projectId, projectMembers.createdAt);

  // Last activity = max(updated_at) across issues + pipeline_runs, per project.
  const issueActivityRows = await db
    .select({
      projectId: issues.projectId,
      lastAt: sql<string | null>`max(${issues.updatedAt})`,
    })
    .from(issues)
    .where(inArray(issues.projectId, projectIds))
    .groupBy(issues.projectId);

  const runActivityRows = await db
    .select({
      projectId: pipelineRuns.projectId,
      lastAt: sql<string | null>`max(${pipelineRuns.updatedAt})`,
    })
    .from(pipelineRuns)
    .where(inArray(pipelineRuns.projectId, projectIds))
    .groupBy(pipelineRuns.projectId);

  const distByProject = new Map<string, Record<string, number>>();
  for (const r of statusRows) {
    const dist = distByProject.get(r.projectId) ?? {};
    dist[r.status] = Number(r.n);
    distByProject.set(r.projectId, dist);
  }

  const blockersByProject = new Map<string, ProjectHealthRow['blockers']>();
  for (const r of blockerRows) {
    const arr = blockersByProject.get(r.projectId) ?? [];
    arr.push({ issueId: `ISS-${r.issSeq}`, documentId: r.id, status: r.status });
    blockersByProject.set(r.projectId, arr);
  }

  const throughputByProject = new Map<string, number>();
  for (const r of throughputRows) throughputByProject.set(r.projectId, Number(r.n));

  const cycleByProject = new Map<string, number>();
  for (const r of cycleRows) {
    if (r.avgDays != null) cycleByProject.set(r.projectId, Number(r.avgDays));
  }

  const liveRunsByProject = new Map<string, number>();
  for (const r of liveRunRows) liveRunsByProject.set(r.projectId, Number(r.n));

  const runnersByProject = new Map<string, number>();
  for (const r of runnerRows) runnersByProject.set(r.projectId, Number(r.n));

  const spendByProject = new Map<string, number>();
  for (const r of spendRows) spendByProject.set(r.project_id, Number(r.spend));

  // Build the capped avatar list + true count from the ordered member rows.
  const memberCountByProject = new Map<string, number>();
  const membersByProject = new Map<string, string[]>();
  for (const r of memberRows) {
    memberCountByProject.set(r.projectId, (memberCountByProject.get(r.projectId) ?? 0) + 1);
    const arr = membersByProject.get(r.projectId) ?? [];
    if (arr.length < MEMBER_AVATAR_CAP) arr.push(emailInitials(r.email));
    membersByProject.set(r.projectId, arr);
  }

  // Merge issue + run activity into a single max-timestamp per project.
  const lastActivityByProject = new Map<string, string | null>();
  const noteActivity = (projectId: string, lastAt: string | null) => {
    if (!lastAt) return;
    const cur = lastActivityByProject.get(projectId);
    if (!cur || lastAt > cur) lastActivityByProject.set(projectId, lastAt);
  };
  for (const r of issueActivityRows) noteActivity(r.projectId, r.lastAt);
  for (const r of runActivityRows) noteActivity(r.projectId, r.lastAt);

  const result: ProjectHealthRow[] = visibleProjects.map((p) => {
    const dist = distByProject.get(p.id) ?? {};
    let totalActive = 0;
    for (const s of ACTIVE_STATUSES) totalActive += dist[s] ?? 0;
    const blockers = blockersByProject.get(p.id) ?? [];
    return {
      id: p.id,
      projectName: p.name,
      projectSlug: p.slug,
      projectMeta: (p.agentConfig as Record<string, unknown> | null) ?? {},
      description: p.description ?? null,
      repoPath: p.repoPath ?? null,
      throughput: throughputByProject.get(p.id) ?? 0,
      totalActive,
      statusDistribution: dist,
      blockers,
      pendingEscalations: dist['needs_info'] ?? 0,
      avgCycleTimeDays: cycleByProject.get(p.id) ?? 0,
      liveRuns: liveRunsByProject.get(p.id) ?? 0,
      runnerCount: runnersByProject.get(p.id) ?? 0,
      spend24hUsd: spendByProject.get(p.id) ?? 0,
      memberCount: memberCountByProject.get(p.id) ?? 0,
      members: membersByProject.get(p.id) ?? [],
      lastActivityAt: lastActivityByProject.get(p.id) ?? null,
    };
  });

  return c.json(result);
});
