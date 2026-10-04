import { eq, inArray, isNotNull, isNull, type SQL } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import {
  agentReportKinds,
  agentReportSeverities,
  agentReports,
  agentReportTargets,
} from '../db/schema.js';
import { assertProjectRole, loadProjectAccess, loadVisibleProjectIds } from '../lib/authz.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { zValidator } from '../middleware/zod-validator.js';
import { refused } from '../project-config/respond.js';
import { issueVisibleIn, listReports, readReport, reportViews, stampReviewed } from './service.js';

const listQuerySchema = z
  .object({
    projectId: z.uuid().optional(),
    // scope=all rolls the feed up across every project the caller can see
    // (owns or member) — bounded via loadVisibleProjectIds, same primitive as
    // the pipeline analytics/project-health routes. Default 'project'.
    scope: z.enum(['project', 'all']).optional(),
    kind: z.enum(agentReportKinds).optional(),
    severity: z.enum(agentReportSeverities).optional(),
    target: z.enum(agentReportTargets).optional(),
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

const badRequest = (details: unknown) =>
  new HTTPException(400, { message: 'Invalid input', cause: { code: 'BAD_REQUEST', details } });

const notFound = (message: string) =>
  new HTTPException(404, { message, cause: { code: 'NOT_FOUND' } });

export const agentReportRoutes = new Hono<{ Variables: AuthVars }>();
agentReportRoutes.use('*', requireAuth(), assertEmailVerified());

agentReportRoutes.get(
  '/',
  zValidator('query', listQuerySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { projectId, scope, kind, severity, target, reviewed, limit } = c.req.valid('query');
    const userId = c.get('userId');
    let scoped: SQL;
    if (scope === 'all') {
      const visibleIds = await loadVisibleProjectIds(userId);
      if (visibleIds.length === 0) return c.json([]);
      scoped = inArray(agentReports.projectId, visibleIds);
    } else {
      if (!projectId) throw badRequest('projectId is required unless scope=all');
      const access = await loadProjectAccess(projectId, userId);
      assertProjectRole(access, 'viewer', 'not a project member');
      scoped = eq(agentReports.projectId, projectId);
    }
    const rows = await listReports(
      [
        scoped,
        kind ? eq(agentReports.kind, kind) : undefined,
        severity ? eq(agentReports.severity, severity) : undefined,
        target ? eq(agentReports.target, target) : undefined,
        reviewed === true ? isNotNull(agentReports.reviewedAt) : undefined,
        reviewed === false ? isNull(agentReports.reviewedAt) : undefined,
      ],
      limit ?? 50,
    );
    return c.json(await reportViews(rows));
  },
);

agentReportRoutes.post(
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
    if (!existing) throw notFound('agent report not found');

    const access = await loadProjectAccess(existing.projectId, userId);
    assertProjectRole(access, 'member', 'not a project member');

    let link: { linkedIssueId?: string | null } = {};
    if (!reviewed) link = { linkedIssueId: null };
    else if (linkedIssueId) {
      if (!(await issueVisibleIn(linkedIssueId, await loadVisibleProjectIds(userId)))) {
        throw notFound('linkedIssueId not found in any project you can see');
      }
      link = { linkedIssueId };
    }

    const out = await stampReviewed([eq(agentReports.id, reportId)], { reviewed, ...link });
    if (!out.ok) return refused(c, out.refusals);
    const [updated] = out.rows;
    if (!updated) throw notFound('agent report not found after update');

    return c.json({
      id: updated.id,
      reviewedAt: updated.reviewedAt?.toISOString() ?? null,
      linkedIssueId: updated.linkedIssueId ?? null,
    });
  },
);

/** What a caller of the old mount is told, on the object it gets back and in its headers. */
export const FEEDBACK_REPORTS_ALIAS_DEPRECATION = {
  alias: '/api/feedback-reports',
  replacement: '/api/agent-reports',
  reason:
    'agent friction reports are `agent_reports` now; the word `feedback` belongs to a person reporting on the product',
  endsWhen: 'forge-plugin no longer calls the alias',
} as const;

// cm:hack the pinned forge-plugin still calls `/api/feedback-reports`, so the old mount answers with
// the same handlers and says it is deprecated — ends when forge-plugin moves to `/api/agent-reports`
// and `forge_agent_report` (logged in forge-local-docs/plugin-followups.md); then delete this mount.
export const feedbackReportsAliasRoutes = new Hono<{ Variables: AuthVars }>();
feedbackReportsAliasRoutes.use('*', async (c, next) => {
  await next();
  const res = c.res;
  const headers = new Headers(res.headers);
  headers.set('Deprecation', 'true');
  headers.set(
    'Link',
    `<${FEEDBACK_REPORTS_ALIAS_DEPRECATION.replacement}>; rel="successor-version"`,
  );
  let body: ReadableStream<Uint8Array> | string | null = res.body;
  if ((res.headers.get('content-type') ?? '').includes('application/json')) {
    const text = await res.text();
    const parsed: unknown = JSON.parse(text);
    // An array keeps its shape: a caller iterating it must not meet a new element; the header says it.
    body =
      parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
        ? JSON.stringify({ ...parsed, deprecation: FEEDBACK_REPORTS_ALIAS_DEPRECATION })
        : text;
    headers.delete('content-length');
  }
  c.res = new Response(body, { status: res.status, statusText: res.statusText, headers });
});
feedbackReportsAliasRoutes.route('/', agentReportRoutes);
