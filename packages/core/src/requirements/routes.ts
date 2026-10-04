import {
  DEFER_REQUIREMENT_SHAPE,
  deferRequirementRequestSchema,
  REPIN_REQUIREMENT_SHAPE,
  repinRequirementRequestSchema,
  UNDEFER_REQUIREMENT_SHAPE,
  undeferRequirementRequestSchema,
} from '@forge/contracts/requirements';
import { Hono } from 'hono';
import { z } from 'zod';
import { egressForRequest } from '../lib/data-egress.js';
import { assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { strictBody } from '../middleware/zod-validator.js';
import { agreeRequirement } from './agree.js';
import { deferRequirement, undeferRequirement } from './deferral.js';
import { requirementLinkRoutes } from './link-routes.js';
import { requirementSummaryOf } from './projection.js';
import { listRequirementsAs, readRequirementAs } from './read.js';
import { repinRequirement } from './repin.js';
import { revisionRoutes } from './revision-routes.js';
import {
  actorOf,
  answer,
  projectParam,
  type RequirementEnv,
  reqParam,
  revisionFields,
  viewQuery,
} from './route-kit.js';
import { createRequirement } from './service.js';

export const requirementRoutes = new Hono<RequirementEnv>();

for (const path of ['/:id/requirements', '/:id/requirements/*']) {
  requirementRoutes.use(path, requireAuth(), assertEmailVerified());
}

requirementRoutes.get('/:id/requirements', projectParam, viewQuery, async (c) => {
  const { id } = c.req.valid('param');
  const listed = await egressForRequest(
    c.get('agency'),
    id,
    'requirement',
    await listRequirementsAs(actorOf(c), id),
    'the requirement list',
  );
  const requirements =
    c.req.valid('query').view === 'summary' ? listed.map(requirementSummaryOf) : listed;
  return c.json({ requirements, returned: requirements.length });
});

requirementRoutes.post(
  '/:id/requirements',
  projectParam,
  strictBody(
    z.strictObject({ title: z.string().trim().min(1).max(500), ...revisionFields }),
    '{ title, reason, spec?, tldr?, changeSummary?, criteria: [{ body, form? }] } writes REQ-n at revision 1',
  ),
  async (c) => {
    const { title, ...write } = c.req.valid('json');
    return answer(
      c,
      await createRequirement({
        projectId: c.req.valid('param').id,
        actor: actorOf(c),
        title,
        write,
      }),
    );
  },
);

requirementRoutes.get('/:id/requirements/:req', reqParam, async (c) => {
  const { id, req } = c.req.valid('param');
  return c.json(
    await egressForRequest(
      c.get('agency'),
      id,
      'requirement',
      await readRequirementAs(actorOf(c), id, req),
      req,
    ),
  );
});

requirementRoutes.route('/', revisionRoutes);

requirementRoutes.post(
  '/:id/requirements/:req/agree',
  reqParam,
  strictBody(
    z.strictObject({
      revision: z.number().int().min(1),
      reason: z.string().max(4_000).nullable().optional(),
    }),
    '{ revision, reason? } names the head revision being agreed',
  ),
  async (c) => {
    const { id, req } = c.req.valid('param');
    const body = c.req.valid('json');
    return answer(
      c,
      await agreeRequirement({
        projectId: id,
        ref: req,
        actor: actorOf(c),
        revision: body.revision,
        reason: body.reason,
      }),
    );
  },
);

requirementRoutes.post(
  '/:id/requirements/:req/repin',
  reqParam,
  strictBody(repinRequirementRequestSchema, REPIN_REQUIREMENT_SHAPE),
  async (c) => {
    const { id, req } = c.req.valid('param');
    const body = c.req.valid('json');
    return answer(
      c,
      await repinRequirement({
        projectId: id,
        ref: req,
        actor: actorOf(c),
        revision: body.revision,
        reason: body.reason,
      }),
    );
  },
);

requirementRoutes.post(
  '/:id/requirements/:req/defer',
  reqParam,
  strictBody(deferRequirementRequestSchema, DEFER_REQUIREMENT_SHAPE),
  async (c) => {
    const { id, req } = c.req.valid('param');
    const body = c.req.valid('json');
    return answer(
      c,
      await deferRequirement({
        projectId: id,
        ref: req,
        actor: actorOf(c),
        reason: body.reason,
        targetPhase: body.targetPhase,
      }),
    );
  },
);

requirementRoutes.post(
  '/:id/requirements/:req/undefer',
  reqParam,
  strictBody(undeferRequirementRequestSchema, UNDEFER_REQUIREMENT_SHAPE),
  async (c) => {
    const { id, req } = c.req.valid('param');
    return answer(
      c,
      await undeferRequirement({
        projectId: id,
        ref: req,
        actor: actorOf(c),
        reason: c.req.valid('json').reason,
      }),
    );
  },
);

requirementRoutes.route('/', requirementLinkRoutes);
