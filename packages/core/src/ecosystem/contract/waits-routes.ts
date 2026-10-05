/**
 * An issue's contract waits over REST (REQ-9 BC-1, E1): list them with the provider's live reading,
 * add one on `contract >= version`, retract one with a reason. The rows are the issue kernel's.
 */

import {
  ADD_CONTRACT_WAIT_SHAPE,
  addContractWaitRequestSchema,
  RETRACT_CONTRACT_WAIT_SHAPE,
  retractContractWaitRequestSchema,
} from '@forge/contracts/contract-waits';
import { Hono } from 'hono';
import { z } from 'zod';
import { resolveIssueRouteRef } from '../../issues/index.js';
import { refused } from '../../lib/refusal.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../../middleware/auth.js';
import { notFound } from '../../middleware/route-errors.js';
import { strictBody, zValidator } from '../../middleware/zod-validator.js';
import { actorFor, projectResource, requireCan } from '../../permissions/index.js';
import {
  addContractWait,
  contractWaitViews,
  issueContractWaits,
  retractContractWait,
} from './waits.js';

const issueParam = z.object({ id: z.string().min(1) });
const waitParam = z.object({ id: z.string().min(1), waitId: z.uuid() });
const scopeQuery = z.object({
  projectId: z.uuid().optional(),
  live: z.enum(['true', 'false']).optional(),
});

export const contractWaitRoutes = new Hono<{ Variables: AuthVars }>();
contractWaitRoutes.use('/:id/contract-waits', requireAuth(), assertEmailVerified());
contractWaitRoutes.use('/:id/contract-waits/*', requireAuth(), assertEmailVerified());

/** GET /api/issues/:id/contract-waits — every wait, settled or not; `live=false` skips the provider reading. */
contractWaitRoutes.get(
  '/:id/contract-waits',
  zValidator('param', issueParam),
  zValidator('query', scopeQuery),
  async (c) => {
    const { projectId, live } = c.req.valid('query');
    const issue = await resolveIssueRouteRef(c.req.valid('param').id, projectId, c.get('userId'));
    return c.json(await issueContractWaits(issue.id, { live: live !== 'false' }));
  },
);

/** POST /api/issues/:id/contract-waits — the issue waits on `contract >= minVersion` until an approved version reaches it. */
contractWaitRoutes.post(
  '/:id/contract-waits',
  zValidator('param', issueParam),
  zValidator('query', scopeQuery),
  strictBody(addContractWaitRequestSchema, ADD_CONTRACT_WAIT_SHAPE),
  async (c) => {
    const userId = c.get('userId');
    const issue = await resolveIssueRouteRef(
      c.req.valid('param').id,
      c.req.valid('query').projectId,
      userId,
    );
    await requireCan(actorFor(userId), 'project.write', projectResource(issue.projectId));
    const body = c.req.valid('json');
    const out = await addContractWait({
      issue: { id: issue.id, projectId: issue.projectId, status: issue.status },
      contract: body.contract,
      minVersion: body.minVersion,
      reason: body.reason ?? null,
      userId,
    });
    if (!out.ok) return refused(c, out.refusals, 'CONTRACT_WAIT_REFUSED');
    const [wait] = await contractWaitViews([out.value], { live: false });
    return c.json({ wait }, 201);
  },
);

/** POST /api/issues/:id/contract-waits/:waitId/retract — the issue no longer waits; the row stays. */
contractWaitRoutes.post(
  '/:id/contract-waits/:waitId/retract',
  zValidator('param', waitParam),
  zValidator('query', scopeQuery),
  strictBody(retractContractWaitRequestSchema, RETRACT_CONTRACT_WAIT_SHAPE),
  async (c) => {
    const userId = c.get('userId');
    const { id, waitId } = c.req.valid('param');
    const issue = await resolveIssueRouteRef(id, c.req.valid('query').projectId, userId);
    await requireCan(actorFor(userId), 'project.write', projectResource(issue.projectId));
    const out = await retractContractWait({
      issueId: issue.id,
      waitId,
      reason: c.req.valid('json').reason,
      userId,
    });
    if (!out) throw notFound(`the issue holds no contract wait ${waitId}`);
    if (!out.ok) return refused(c, out.refusals, 'CONTRACT_WAIT_REFUSED');
    const [wait] = await contractWaitViews([out.value], { live: false });
    return c.json({ wait });
  },
);
