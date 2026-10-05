import {
  TRIAGE_AGENT_REPORT_SHAPE,
  type TriageAgentReportRequest,
  triageAgentReportRequestSchema,
} from '@forge/contracts/agent-reports';
import { eq } from 'drizzle-orm';
import { type Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { agentReports } from '../db/schema.js';
import { loadProjectAccess, loadVisibleProjectIds } from '../lib/authz.js';
import { buildListEnvelope } from '../lib/list-envelope.js';
import { refused } from '../lib/refusal.js';
import { type AuthVars, assertEmailVerified, requireAuth, restActor } from '../middleware/auth.js';
import { strictBody, zValidator } from '../middleware/zod-validator.js';
import { requireHeld } from '../permissions/index.js';
import {
  fileReport,
  readOneReport,
  readReportFeed,
  reportFiltersSchema,
  submitReportSchema,
} from './reports.js';
import { readReport, visibleIssue } from './service.js';
import { type ReportActor, type TriageOutcome, triageReports } from './triage.js';

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
  if (!out.ok) return refused(c, out.refusals, 'AGENT_REPORT_REFUSED');
  return c.json({ effect: out.effect });
}

export const agentReportRoutes = new Hono<{ Variables: AuthVars }>();
agentReportRoutes.use('*', requireAuth(), assertEmailVerified());
const feedQuerySchema = reportFiltersSchema
  .extend({
    projectId: z.uuid().optional(),
    scope: z.enum(['project', 'all']).optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
  })
  .strict();

agentReportRoutes.post(
  '/',
  strictBody(
    submitReportSchema,
    '{ projectId, kind, target, summary, severity?, targetRef?, detail?, suggestion? }',
  ),
  async (c) => {
    const body = c.req.valid('json');
    const deviceId = c.get('patDeviceId') ?? null;
    const out = await fileReport(
      { userId: c.get('userId'), deviceId, boundProjectId: body.projectId },
      body,
    );
    return c.json(out, out.ok ? 201 : 200);
  },
);

agentReportRoutes.get(
  '/',
  zValidator('query', feedQuerySchema, (r) => {
    if (!r.success) throw badRequest(r.error);
  }),
  async (c) => {
    const { projectId, scope, limit: asked, ...filters } = c.req.valid('query');
    const userId = c.get('userId');
    const all = scope === 'all';
    if (!all && !projectId) throw badRequest('projectId is required unless scope=all');
    if (!all && projectId) requireHeld(await loadProjectAccess(projectId, userId), 'project.read');
    const limit = asked ?? (all ? 50 : 25);
    const projectIds = all ? await loadVisibleProjectIds(userId) : [projectId as string];
    const items = await readReportFeed(projectIds, filters, limit);
    return c.json(
      buildListEnvelope({
        key: 'reports',
        items,
        limit,
        hint: 'narrow with kind/target/severity/triage filters',
      }),
    );
  },
);

agentReportRoutes.get('/:id', async (c) => {
  const reportId = c.req.param('id');
  if (!z.uuid().safeParse(reportId).success) throw badRequest('id must be a valid uuid');
  const report = await readOneReport(c.get('userId'), reportId);
  if (!report) throw notFound(`agent report ${reportId} not found`);
  return c.json({ report });
});

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
    requireHeld(access, 'project.write');
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
