import {
  AGENT_REPORT_TRIAGES,
  TRIAGE_AGENT_REPORT_SHAPE,
  TRIAGE_AGENT_REPORTS_BY_SIGNAL_SHAPE,
  type TriageAgentReportRequest,
  triageAgentReportRequestSchema,
  triageAgentReportsBySignalRequestSchema,
} from '@forge/contracts/agent-reports';
import { eq, inArray, type SQL } from 'drizzle-orm';
import { type Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import {
  agentReportKinds,
  agentReportSeverities,
  agentReports,
  agentReportTargets,
} from '../db/schema.js';
import { assertProjectRole, loadProjectAccess, loadVisibleProjectIds } from '../lib/authz.js';
import { refusalEnvelope } from '../lib/refusal.js';
import { type AuthVars, assertEmailVerified, requireAuth, restActor } from '../middleware/auth.js';
import { strictBody, zValidator } from '../middleware/zod-validator.js';
import {
  announceFiled,
  listReports,
  type ReportActor,
  readReport,
  reportViews,
  type TriageOutcome,
  triageReports,
  visibleIssue,
} from './service.js';

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
    triage: z.enum(AGENT_REPORT_TRIAGES).optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
  })
  .strict();

const badRequest = (details: unknown) =>
  new HTTPException(400, { message: 'Invalid input', cause: { code: 'BAD_REQUEST', details } });

const notFound = (message: string) =>
  new HTTPException(404, { message, cause: { code: 'NOT_FOUND' } });

type Ctx = Context<{ Variables: AuthVars }>;

/** The issue a file act names, when the caller can see it; anything else is the design's NOT_FOUND. */
async function linkOf(c: Ctx, act: TriageAgentReportRequest) {
  if (act.act !== 'file' || !act.issue) return null;
  const issue = await visibleIssue(act.issue, await loadVisibleProjectIds(c.get('userId')));
  if (!issue) throw notFound(`issue ${act.issue} not found in any project you can see`);
  return issue;
}

function actorOf(c: Ctx): ReportActor {
  const { id, agency } = restActor(c);
  return { userId: id, agency };
}

async function answer(c: Ctx, out: TriageOutcome) {
  if (!out.ok) return c.json(refusalEnvelope(out.refusals, 'AGENT_REPORT_REFUSED'), 422);
  await announceFiled(out, actorOf(c));
  return c.json({ effect: out.effect });
}

export const agentReportRoutes = new Hono<{ Variables: AuthVars }>();
agentReportRoutes.use('*', requireAuth(), assertEmailVerified());

agentReportRoutes.get(
  '/',
  zValidator('query', listQuerySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { projectId, scope, kind, severity, target, triage, limit } = c.req.valid('query');
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
        triage ? eq(agentReports.triage, triage) : undefined,
      ],
      limit ?? 50,
    );
    return c.json(await reportViews(rows));
  },
);

agentReportRoutes.post(
  '/triage',
  strictBody(triageAgentReportsBySignalRequestSchema, TRIAGE_AGENT_REPORTS_BY_SIGNAL_SHAPE),
  async (c) => {
    const body = c.req.valid('json');
    const userId = c.get('userId');
    let scoped: SQL;
    if (body.scope === 'all') {
      if (body.triage.act === 'file' && body.triage.createIssue) {
        throw badRequest(
          'createIssue files into one project, so a scope=all triage names an existing issue instead',
        );
      }
      scoped = inArray(agentReports.projectId, await loadVisibleProjectIds(userId));
    } else {
      if (!body.projectId) throw badRequest('projectId is required unless scope=all');
      const access = await loadProjectAccess(body.projectId, userId);
      assertProjectRole(access, 'member', 'not a project member');
      scoped = eq(agentReports.projectId, body.projectId);
    }
    const out = await triageReports({
      scope: [scoped, eq(agentReports.signalKey, body.signalKey)],
      bulk: true,
      act: body.triage,
      actor: actorOf(c),
      channel: 'web',
      linkIssue: await linkOf(c, body.triage),
    });
    return answer(c, out);
  },
);

agentReportRoutes.post(
  '/:id/triage',
  strictBody(triageAgentReportRequestSchema, TRIAGE_AGENT_REPORT_SHAPE),
  async (c) => {
    const reportId = c.req.param('id');
    if (!z.uuid().safeParse(reportId).success) throw badRequest('id must be a valid uuid');
    const act = c.req.valid('json');
    const existing = await readReport(reportId);
    if (!existing) throw notFound(`agent report ${reportId} not found`);
    const access = await loadProjectAccess(existing.projectId, c.get('userId'));
    assertProjectRole(access, 'member', 'not a project member');
    const out = await triageReports({
      scope: [eq(agentReports.id, reportId)],
      bulk: false,
      act,
      actor: actorOf(c),
      channel: 'web',
      linkIssue: await linkOf(c, act),
    });
    return answer(c, out);
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
