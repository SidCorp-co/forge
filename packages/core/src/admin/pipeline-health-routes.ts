/**
 * Admin pipeline-health surface.
 *
 * GET /api/admin/pipeline/health
 *   Lists issues currently parked at `waiting` (the single human-review state
 *   the failure path now routes to — ISS-393 replaced the manualHold-block
 *   model) plus an aggregate failure-kind breakdown for SRE dashboards.
 */

import { and, count, desc, eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { db } from '../db/client.js';
import { issues, jobs, projects } from '../db/schema.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { requireAdmin } from '../middleware/require-admin.js';

export const pipelineHealthAdminRoutes = new Hono<{ Variables: AuthVars }>();
pipelineHealthAdminRoutes.use('*', requireAuth(), assertEmailVerified(), requireAdmin());

pipelineHealthAdminRoutes.get('/health', async (c) => {
  const waiting = await db
    .select({
      id: issues.id,
      issSeq: issues.issSeq,
      title: issues.title,
      projectId: issues.projectId,
      projectSlug: projects.slug,
      projectName: projects.name,
      status: issues.status,
      updatedAt: issues.updatedAt,
    })
    .from(issues)
    .innerJoin(projects, eq(projects.id, issues.projectId))
    .where(eq(issues.status, 'waiting'))
    .orderBy(desc(issues.updatedAt))
    .limit(100);

  // Latest failure breakdown per kind for the last 24h (signal for SRE).
  const failureBreakdown = await db
    .select({
      failureKind: jobs.failureKind,
      count: count(),
    })
    .from(jobs)
    .where(
      and(
        eq(jobs.status, 'failed'),
        sql`${jobs.finishedAt} > now() - interval '24 hours'`,
      ),
    )
    .groupBy(jobs.failureKind);

  return c.json({
    waiting,
    failureBreakdown: failureBreakdown.map((r) => ({
      kind: r.failureKind ?? 'unclassified',
      count: Number(r.count),
    })),
  });
});
