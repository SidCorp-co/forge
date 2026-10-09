import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { feedbackKinds, feedbackSeverities, feedbackTargets } from '../db/feedback-vocabulary.js';
import { assertProjectRole, loadProjectAccess, loadVisibleProjectIds } from '../lib/authz.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { issueVisibleIn, listReports, readReport, stampReviewed } from './service.js';

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
    // The issue this report was curated INTO (distinct from the source
    // issue). Must belong to the same project as the report, or 404.
    linkedIssueId: z.uuid().optional(),
  })
  .strict();

const serialize = <R extends { reviewedAt: Date | null; createdAt: Date }>(r: R) => ({
  ...r,
  reviewedAt: r.reviewedAt?.toISOString() ?? null,
  createdAt: r.createdAt.toISOString(),
});

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

    const filters = { kind, severity, target, reviewed };

    if (scope === 'all') {
      const visibleIds = await loadVisibleProjectIds(userId);
      if (visibleIds.length === 0) return c.json([]);
      const rows = await listReports(visibleIds, filters, limit ?? 50);
      return c.json(rows.map(({ issueId, runId, jobId, stage, ...r }) => serialize(r)));
    }

    if (!projectId) {
      throw badRequest('projectId is required unless scope=all');
    }

    const access = await loadProjectAccess(projectId, userId);
    assertProjectRole(access, 'viewer', 'not a project member');

    const rows = await listReports([projectId], filters, limit ?? 50);
    // REST endpoint is human-facing (web UI); React escapes all text on render.
    // No untrusted framing needed here — that's for AI-facing MCP list only.
    return c.json(
      rows.map(({ issueId, runId, jobId, stage, projectId: _p, projectSlug, ...r }) =>
        serialize(r),
      ),
    );
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
    const { reviewed, linkedIssueId } = c.req.valid('json');
    const userId = c.get('userId');

    const existing = await readReport(reportId);

    if (!existing) throw notFound('feedback report not found');

    const access = await loadProjectAccess(existing.projectId, userId);
    assertProjectRole(access, 'member', 'not a project member');

    if (reviewed && linkedIssueId) {
      const visibleIds = await loadVisibleProjectIds(userId);
      if (!(await issueVisibleIn(linkedIssueId, visibleIds))) {
        throw notFound('linkedIssueId not found in any project you can see');
      }
    }

    const [updated] = await stampReviewed(
      { projectIds: [existing.projectId], reportId },
      { reviewed, linkedIssueId },
    );

    if (!updated) throw notFound('feedback report not found after update');

    return c.json({
      id: updated.id,
      reviewedAt: updated.reviewedAt?.toISOString() ?? null,
      linkedIssueId: updated.linkedIssueId ?? null,
    });
  },
);
