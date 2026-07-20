import { zValidator } from '@hono/zod-validator';
import { and, desc, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { db } from '../db/client.js';
import {
  feedbackKinds,
  feedbackReports,
  feedbackSeverities,
  feedbackTargets,
  projects,
} from '../db/schema.js';
import { assertProjectRole, loadProjectAccess, loadVisibleProjectIds } from '../lib/authz.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';

const listQuerySchema = z
  .object({
    projectId: z.uuid().optional(),
    // scope=all rolls the feed up across every project the caller can see
    // (owns or member) — bounded via loadVisibleProjectIds, same primitive as
    // the pipeline analytics/project-health routes. Default 'project'.
    scope: z.enum(['project', 'all']).optional(),
    kind: z.enum(feedbackKinds).optional(),
    severity: z.enum(feedbackSeverities).optional(),
    target: z.enum(feedbackTargets).optional(),
    reviewed: z
      .union([z.literal('true'), z.literal('false'), z.boolean()])
      .optional()
      .transform((v) => (v === undefined ? undefined : v === true || v === 'true')),
    limit: z.coerce.number().int().min(1).max(200).optional(),
  })
  .strict();

const markReviewedBodySchema = z
  .object({
    reviewed: z.boolean(),
  })
  .strict();

const badRequest = (details: unknown) =>
  new HTTPException(400, { message: 'Invalid input', cause: { code: 'BAD_REQUEST', details } });

const notFound = (message: string) =>
  new HTTPException(404, { message, cause: { code: 'NOT_FOUND' } });

export const feedbackReportRoutes = new Hono<{ Variables: AuthVars }>();
feedbackReportRoutes.use('*', requireAuth(), assertEmailVerified());

feedbackReportRoutes.get(
  '/',
  zValidator('query', listQuerySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { projectId, scope, kind, severity, target, reviewed, limit } = c.req.valid('query');
    const userId = c.get('userId');

    if (scope === 'all') {
      const visibleIds = await loadVisibleProjectIds(userId);
      if (visibleIds.length === 0) return c.json([]);

      const conditions = [inArray(feedbackReports.projectId, visibleIds)];
      if (kind) conditions.push(eq(feedbackReports.kind, kind));
      if (severity) conditions.push(eq(feedbackReports.severity, severity));
      if (target) conditions.push(eq(feedbackReports.target, target));
      if (reviewed === true) conditions.push(isNotNull(feedbackReports.reviewedAt));
      if (reviewed === false) conditions.push(isNull(feedbackReports.reviewedAt));

      const rows = await db
        .select({
          id: feedbackReports.id,
          projectId: feedbackReports.projectId,
          projectSlug: projects.slug,
          kind: feedbackReports.kind,
          severity: feedbackReports.severity,
          target: feedbackReports.target,
          targetRef: feedbackReports.targetRef,
          summary: feedbackReports.summary,
          detail: feedbackReports.detail,
          suggestion: feedbackReports.suggestion,
          signalKey: feedbackReports.signalKey,
          sessionId: feedbackReports.sessionId,
          reviewedAt: feedbackReports.reviewedAt,
          createdAt: feedbackReports.createdAt,
        })
        .from(feedbackReports)
        .leftJoin(projects, eq(projects.id, feedbackReports.projectId))
        .where(and(...conditions))
        .orderBy(desc(feedbackReports.createdAt))
        .limit(limit ?? 50);

      const serialized = rows.map((r) => ({
        ...r,
        reviewedAt: r.reviewedAt?.toISOString() ?? null,
        createdAt: r.createdAt.toISOString(),
      }));

      return c.json(serialized);
    }

    if (!projectId) {
      throw badRequest('projectId is required unless scope=all');
    }

    const access = await loadProjectAccess(projectId, userId);
    assertProjectRole(access, 'viewer', 'not a project member');

    const conditions = [eq(feedbackReports.projectId, projectId)];
    if (kind) conditions.push(eq(feedbackReports.kind, kind));
    if (severity) conditions.push(eq(feedbackReports.severity, severity));
    if (target) conditions.push(eq(feedbackReports.target, target));
    if (reviewed === true) conditions.push(isNotNull(feedbackReports.reviewedAt));
    if (reviewed === false) conditions.push(isNull(feedbackReports.reviewedAt));

    const rows = await db
      .select({
        id: feedbackReports.id,
        kind: feedbackReports.kind,
        severity: feedbackReports.severity,
        target: feedbackReports.target,
        targetRef: feedbackReports.targetRef,
        summary: feedbackReports.summary,
        detail: feedbackReports.detail,
        suggestion: feedbackReports.suggestion,
        signalKey: feedbackReports.signalKey,
        sessionId: feedbackReports.sessionId,
        reviewedAt: feedbackReports.reviewedAt,
        createdAt: feedbackReports.createdAt,
      })
      .from(feedbackReports)
      .where(and(...conditions))
      .orderBy(desc(feedbackReports.createdAt))
      .limit(limit ?? 50);

    // REST endpoint is human-facing (web UI); React escapes all text on render.
    // No untrusted framing needed here — that's for AI-facing MCP list only.
    const serialized = rows.map((r) => ({
      ...r,
      reviewedAt: r.reviewedAt?.toISOString() ?? null,
      createdAt: r.createdAt.toISOString(),
    }));

    return c.json(serialized);
  },
);

feedbackReportRoutes.post(
  '/:id/reviewed',
  zValidator('json', markReviewedBodySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const reportId = c.req.param('id');
    if (!z.string().uuid().safeParse(reportId).success) {
      throw badRequest('id must be a valid uuid');
    }
    const { reviewed } = c.req.valid('json');
    const userId = c.get('userId');

    const [existing] = await db
      .select({ id: feedbackReports.id, projectId: feedbackReports.projectId })
      .from(feedbackReports)
      .where(eq(feedbackReports.id, reportId))
      .limit(1);

    if (!existing) throw notFound('feedback report not found');

    const access = await loadProjectAccess(existing.projectId, userId);
    assertProjectRole(access, 'member', 'not a project member');

    const [updated] = await db
      .update(feedbackReports)
      .set({ reviewedAt: reviewed ? new Date() : null })
      .where(eq(feedbackReports.id, reportId))
      .returning({
        id: feedbackReports.id,
        reviewedAt: feedbackReports.reviewedAt,
      });

    if (!updated) throw notFound('feedback report not found after update');

    return c.json({
      id: updated.id,
      reviewedAt: updated.reviewedAt?.toISOString() ?? null,
    });
  },
);
