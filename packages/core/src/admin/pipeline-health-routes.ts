/**
 * Admin pipeline-health surface.
 *
 * GET /api/admin/pipeline/health
 *   Lists issues currently blocked by the manualHold-block model
 *   (`manual_hold = true AND failure_context IS NOT NULL`) plus aggregate
 *   failure-kind breakdown for SRE dashboards.
 *
 * POST /api/admin/pipeline/clear-hold/:issueId
 *   Admin override. Clears `manual_hold` + `failure_context` so the
 *   dispatcher picks the issue up on the next sweep tick. Equivalent to
 *   the per-issue "Resume" button on the operator UI — exposed here for
 *   bulk recovery scripts and admin tooling.
 */

import { zValidator } from '@hono/zod-validator';
import { and, count, desc, eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { db } from '../db/client.js';
import { issues, jobs, projects } from '../db/schema.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { requireAdmin } from '../middleware/require-admin.js';

const idParamSchema = z.object({ issueId: z.uuid() });

const badRequest = (details: unknown) =>
  new HTTPException(400, { message: 'Invalid input', cause: { code: 'BAD_REQUEST', details } });

const notFound = () =>
  new HTTPException(404, { message: 'issue not found', cause: { code: 'NOT_FOUND' } });

export const pipelineHealthAdminRoutes = new Hono<{ Variables: AuthVars }>();
pipelineHealthAdminRoutes.use('*', requireAuth(), assertEmailVerified(), requireAdmin());

pipelineHealthAdminRoutes.get('/health', async (c) => {
  const blocked = await db
    .select({
      id: issues.id,
      issSeq: issues.issSeq,
      title: issues.title,
      projectId: issues.projectId,
      projectSlug: projects.slug,
      projectName: projects.name,
      status: issues.status,
      manualHold: issues.manualHold,
      failureContext: issues.failureContext,
      updatedAt: issues.updatedAt,
    })
    .from(issues)
    .innerJoin(projects, eq(projects.id, issues.projectId))
    .where(and(eq(issues.manualHold, true), sql`${issues.failureContext} IS NOT NULL`))
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
    blocked,
    failureBreakdown: failureBreakdown.map((r) => ({
      kind: r.failureKind ?? 'unclassified',
      count: Number(r.count),
    })),
  });
});

pipelineHealthAdminRoutes.post(
  '/clear-hold/:issueId',
  zValidator('param', idParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { issueId } = c.req.valid('param');

    const [updated] = await db
      .update(issues)
      .set({
        manualHold: false,
        failureContext: null,
        updatedAt: new Date(),
      })
      .where(eq(issues.id, issueId))
      .returning({
        id: issues.id,
        status: issues.status,
        manualHold: issues.manualHold,
      });

    if (!updated) throw notFound();

    return c.json({
      issueId: updated.id,
      status: updated.status,
      manualHold: updated.manualHold,
      ok: true,
    });
  },
);
