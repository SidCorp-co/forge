import { Hono } from 'hono';
import { z } from 'zod';
import { type AuthVars, assertEmailVerified, requireAuth, restActor } from '../middleware/auth.js';
import { idParamSchema } from '../middleware/route-errors.js';
import { zValidator } from '../middleware/zod-validator.js';
import {
  heldIssue,
  issueRouteIdParamSchema,
  projectScopeQuerySchema,
  resolveIssueRouteRef,
} from './issue-route-ref.js';
import { triggerPipelineStepManual } from './ports.js';
import { issueUsageTotals } from './read-service.js';

const runPipelineStepBodySchema = z.object({}).strict();
export const issueExtrasRoutes = new Hono<{ Variables: AuthVars }>();
issueExtrasRoutes.use('*', requireAuth(), assertEmailVerified());

issueExtrasRoutes.post(
  '/:id/run-pipeline-step',
  zValidator('param', idParamSchema),
  zValidator('json', runPipelineStepBodySchema),
  async (c) => {
    const { id: issueId } = c.req.valid('param');
    const userId = c.get('userId');

    const issue = await heldIssue(issueId, userId, 'project.write', "starting an issue's pipeline");

    const { startedAt } = await triggerPipelineStepManual({
      projectId: issue.projectId,
      issueId: issue.id,
      status: issue.status,
      actor: restActor(c),
      reason: { manual: true },
    });
    return c.json({ issueId: issue.id, status: issue.status, startedAt }, 202);
  },
);

issueExtrasRoutes.get(
  '/:id/cost-summary',
  zValidator('param', issueRouteIdParamSchema),
  zValidator('query', projectScopeQuerySchema),
  async (c) => {
    const { id: rawId } = c.req.valid('param');
    const { projectId: projectIdQuery } = c.req.valid('query');
    const userId = c.get('userId');

    const issue = await resolveIssueRouteRef(rawId, projectIdQuery, userId);
    const issueId = issue.id;

    return c.json({
      issueId,
      projectId: issue.projectId,
      ...(await issueUsageTotals(issueId)),
    });
  },
);
