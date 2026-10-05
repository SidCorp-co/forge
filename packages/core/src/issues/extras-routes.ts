import { Hono } from 'hono';
import { z } from 'zod';
import { issuePriorities, issueStatuses } from '../db/schema.js';
import { type AuthVars, assertEmailVerified, requireAuth, restActor } from '../middleware/auth.js';
import { idParamSchema } from '../middleware/route-errors.js';
import { zValidator } from '../middleware/zod-validator.js';
import { triggerPipelineStepManual } from '../pipeline/index.js';
import { patchIssueBatch } from './batch-patch.js';
import {
  heldIssue,
  issueRouteIdParamSchema,
  projectScopeQuerySchema,
  resolveIssueRouteRef,
} from './issue-route-ref.js';
import { issueUsageTotals } from './read-service.js';

const runPipelineStepBodySchema = z.object({}).strict();

const batchPatchBodySchema = z
  .object({
    ids: z.array(z.uuid()).min(1).max(100),
    data: z
      .object({
        status: z.enum(issueStatuses).optional(),
        priority: z.enum(issuePriorities).optional(),
        category: z.string().trim().min(1).max(100).nullable().optional(),
      })
      .strict()
      .refine((o) => Object.keys(o).length > 0, { message: 'no fields to update' }),
  })
  .strict();
export const issueExtrasRoutes = new Hono<{ Variables: AuthVars }>();
issueExtrasRoutes.use('*', requireAuth(), assertEmailVerified());

issueExtrasRoutes.patch('/batch', zValidator('json', batchPatchBodySchema), async (c) => {
  const { ids, data } = c.req.valid('json');
  return c.json(await patchIssueBatch(ids, data, c.get('userId'), restActor(c)));
});

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
