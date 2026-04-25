import { and, eq, inArray, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { db } from '../db/client.js';
import { activityLog, issues, projectMembers, projects, users } from '../db/schema.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';

interface ProjectHealthRow {
  projectName: string;
  projectSlug: string;
  projectMeta: Record<string, unknown>;
  throughput: number;
  totalActive: number;
  statusDistribution: Record<string, number>;
  blockers: Array<{ issueId: string; documentId: string; status: string }>;
  pendingEscalations: number;
  avgCycleTimeDays: number;
}

const ACTIVE_STATUSES = ['open', 'confirmed', 'waiting', 'approved', 'in_progress', 'developed', 'deploying', 'testing', 'tested', 'pass', 'staging', 'reopen'] as const;
const BLOCKED_STATUSES = ['on_hold', 'needs_info'] as const;

export const projectHealthRoutes = new Hono<{ Variables: AuthVars }>();
projectHealthRoutes.use('/health', requireAuth(), assertEmailVerified());

projectHealthRoutes.get('/health', async (c) => {
  const userId = c.get('userId');

  // CEO sees all projects; everyone else sees own + member projects.
  const [me] = await db
    .select({ id: users.id, isCeo: users.isCeo })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  const visibleProjects = me?.isCeo
    ? await db
        .select({ id: projects.id, slug: projects.slug, name: projects.name, agentConfig: projects.agentConfig })
        .from(projects)
    : await db
        .selectDistinct({
          id: projects.id,
          slug: projects.slug,
          name: projects.name,
          agentConfig: projects.agentConfig,
        })
        .from(projects)
        .leftJoin(projectMembers, eq(projectMembers.projectId, projects.id))
        .where(
          sql`${projects.ownerId} = ${userId} OR ${projectMembers.userId} = ${userId}`,
        );

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
      and(
        inArray(issues.projectId, projectIds),
        inArray(issues.status, [...BLOCKED_STATUSES]),
      ),
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
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
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
        sql`${activityLog.action} LIKE 'transition.%'`,
        sql`${activityLog.payload} ->> 'to' IN ('closed','released')`,
        sql`${activityLog.createdAt} >= ${sevenDaysAgo}`,
      ),
    )
    .groupBy(issues.projectId);

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

  const result: ProjectHealthRow[] = visibleProjects.map((p) => {
    const dist = distByProject.get(p.id) ?? {};
    let totalActive = 0;
    for (const s of ACTIVE_STATUSES) totalActive += dist[s] ?? 0;
    const blockers = blockersByProject.get(p.id) ?? [];
    return {
      projectName: p.name,
      projectSlug: p.slug,
      projectMeta: (p.agentConfig as Record<string, unknown> | null) ?? {},
      throughput: throughputByProject.get(p.id) ?? 0,
      totalActive,
      statusDistribution: dist,
      blockers,
      pendingEscalations: dist['needs_info'] ?? 0,
      avgCycleTimeDays: 0,
    };
  });

  return c.json(result);
});
