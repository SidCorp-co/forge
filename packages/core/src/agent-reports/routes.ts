import {
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
import { agentReports } from '../db/schema.js';
import { loadProjectAccess, loadVisibleProjectIds } from '../lib/authz.js';
import { refused } from '../lib/refusal.js';
import { type AuthVars, assertEmailVerified, requireAuth, restActor } from '../middleware/auth.js';
import { strictBody } from '../middleware/zod-validator.js';
import { requireHeld } from '../permissions/index.js';
import { listVisibleProjectsWithRole } from '../projects/index.js';
import { readReport, visibleIssue, writableProjectIds } from './service.js';
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
      const writable = writableProjectIds(await listVisibleProjectsWithRole(userId));
      if (writable.length === 0) throw notFound('no project you can write to holds agent reports');
      scoped = inArray(agentReports.projectId, writable);
    } else {
      if (!body.projectId) throw badRequest('projectId is required unless scope=all');
      const access = await loadProjectAccess(body.projectId, userId);
      requireHeld(access, 'project.write');
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
