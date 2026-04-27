/**
 * Admin pipeline-health surface (Phase H, ISS-306).
 *
 * GET /api/admin/pipeline/health
 *   Lists issues that the sweeper has touched recently — escalated to
 *   `pipeline_failed` OR currently mid-recovery (recovery_attempts > 0).
 *   Plus aggregate counts so the dashboard widget can render at-a-glance.
 *
 * POST /api/admin/pipeline/recover/:issueId
 *   Manual override. Resets `recovery_attempts` + `recovery_window_started_at`
 *   to zero/now so the sweeper gives the issue a fresh budget on the next
 *   tick. Useful when the underlying upstream block (e.g. Anthropic
 *   content filter) is fixed and an admin wants to retry without waiting
 *   the 24h window.
 */

import { zValidator } from '@hono/zod-validator';
import { and, count, desc, eq, gt, inArray, sql } from 'drizzle-orm';
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
  const escalated = await db
    .select({
      id: issues.id,
      issSeq: issues.issSeq,
      title: issues.title,
      projectId: issues.projectId,
      projectSlug: projects.slug,
      projectName: projects.name,
      status: issues.status,
      recoveryAttempts: issues.recoveryAttempts,
      lastRecoveryAt: issues.lastRecoveryAt,
      recoveryWindowStartedAt: issues.recoveryWindowStartedAt,
      updatedAt: issues.updatedAt,
    })
    .from(issues)
    .innerJoin(projects, eq(projects.id, issues.projectId))
    .where(eq(issues.status, 'pipeline_failed'))
    .orderBy(desc(issues.updatedAt))
    .limit(100);

  const recovering = await db
    .select({
      id: issues.id,
      issSeq: issues.issSeq,
      title: issues.title,
      projectId: issues.projectId,
      projectSlug: projects.slug,
      projectName: projects.name,
      status: issues.status,
      recoveryAttempts: issues.recoveryAttempts,
      lastRecoveryAt: issues.lastRecoveryAt,
      recoveryWindowStartedAt: issues.recoveryWindowStartedAt,
      updatedAt: issues.updatedAt,
    })
    .from(issues)
    .innerJoin(projects, eq(projects.id, issues.projectId))
    .where(and(gt(issues.recoveryAttempts, 0), eq(issues.status, 'confirmed' as never)))
    .orderBy(desc(issues.lastRecoveryAt))
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
    escalated,
    recovering,
    failureBreakdown: failureBreakdown.map((r) => ({
      kind: r.failureKind ?? 'unclassified',
      count: Number(r.count),
    })),
  });
});

pipelineHealthAdminRoutes.post(
  '/recover/:issueId',
  zValidator('param', idParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { issueId } = c.req.valid('param');

    const [updated] = await db
      .update(issues)
      .set({
        recoveryAttempts: 0,
        lastRecoveryAt: null,
        recoveryWindowStartedAt: null,
        // If currently pipeline_failed, drop back to confirmed so the
        // orchestrator picks the issue up on the next sweep tick. The
        // human triggering this endpoint is signalling "yes, try again".
        status: sql`CASE WHEN status = 'pipeline_failed' THEN 'confirmed' ELSE status END`,
        updatedAt: new Date(),
      })
      .where(eq(issues.id, issueId))
      .returning({
        id: issues.id,
        status: issues.status,
        recoveryAttempts: issues.recoveryAttempts,
      });

    if (!updated) throw notFound();

    return c.json({
      issueId: updated.id,
      status: updated.status,
      recoveryAttempts: updated.recoveryAttempts,
      ok: true,
    });
  },
);

// Re-export so import sites don't need to know which router holds it. inArray
// is referenced indirectly via Drizzle's tagged-template SQL above.
void inArray;
