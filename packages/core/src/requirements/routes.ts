import {
  ACCEPT_REVISION_SHAPE,
  acceptRevisionRequestSchema,
  DEFER_REQUIREMENT_SHAPE,
  deferRequirementRequestSchema,
  REPIN_REQUIREMENT_SHAPE,
  repinRequirementRequestSchema,
  UNDEFER_REQUIREMENT_SHAPE,
  undeferRequirementRequestSchema,
} from '@forge/contracts/requirements';
import { type Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { strictBody, zValidator } from '../middleware/zod-validator.js';
import { refused } from '../project-config/respond.js';
import { deferRequirement, undeferRequirement } from './deferral.js';
import { linkIssue, linkWorkflow, unlinkIssue, unlinkWorkflow } from './issue-links.js';
import { listRequirementsAs, type RequirementActor, readRequirementAs } from './read.js';
import { repinRequirement } from './repin.js';
import { criterionSchema, specSchema } from './schemas.js';
import {
  acceptRevision,
  agreeRequirement,
  createRequirement,
  proposeRevision,
  type RequirementOutcome,
  returnRevision,
  writeRevision,
} from './service.js';

export const requirementRoutes = new Hono<{ Variables: AuthVars }>();

for (const path of ['/:id/requirements', '/:id/requirements/*']) {
  requirementRoutes.use(path, requireAuth(), assertEmailVerified());
}

const badRequest = (message: string) =>
  new HTTPException(400, { message, cause: { code: 'BAD_REQUEST' } });

const projectParam = zValidator('param', z.object({ id: z.uuid() }), (r) => {
  if (!r.success) throw badRequest('invalid path: the project id is a uuid');
});

const reqParam = zValidator(
  'param',
  z.object({ id: z.uuid(), req: z.string().trim().min(1).max(64) }),
  (r) => {
    if (!r.success) throw badRequest('invalid path: a project uuid and a requirement uuid or key');
  },
);

const revisionParam = zValidator(
  'param',
  z.object({
    id: z.uuid(),
    req: z.string().trim().min(1).max(64),
    n: z.coerce.number().int().min(1),
  }),
  (r) => {
    if (!r.success)
      throw badRequest('invalid path: a project uuid, a requirement and a revision number');
  },
);

const revisionFields = {
  reason: z.string().max(4_000),
  spec: specSchema.optional(),
  tldr: z.string().max(4_000).nullable().optional(),
  changeSummary: z.string().max(4_000).nullable().optional(),
  criteria: z.array(criterionSchema).max(200),
};

function actorOf(c: Context<{ Variables: AuthVars }>): RequirementActor {
  const agency = c.get('agency');
  if (!agency) throw new Error('requirements: a request reached its handler without an auth gate');
  return { userId: c.get('userId'), agency };
}

function answer(c: Context, outcome: RequirementOutcome) {
  if (!outcome.ok) return refused(c, outcome.refusals);
  return c.json(outcome.requirement, outcome.created ? 201 : 200);
}

requirementRoutes.get('/:id/requirements', projectParam, async (c) => {
  const requirements = await listRequirementsAs(actorOf(c), c.req.valid('param').id);
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
  return c.json(await readRequirementAs(actorOf(c), id, req));
});

requirementRoutes.post(
  '/:id/requirements/:req/revisions',
  reqParam,
  strictBody(
    z.strictObject({ baseRevision: z.number().int().min(1).nullable(), ...revisionFields }),
    '{ baseRevision, reason, spec?, tldr?, changeSummary?, criteria: [{ code?, body, form? }] } — baseRevision is the head you read',
  ),
  async (c) => {
    const { id, req } = c.req.valid('param');
    const { baseRevision, ...write } = c.req.valid('json');
    return answer(
      c,
      await writeRevision({ projectId: id, ref: req, actor: actorOf(c), baseRevision, write }),
    );
  },
);

requirementRoutes.put(
  '/:id/requirements/:req/revisions/:n',
  revisionParam,
  strictBody(
    z.strictObject(revisionFields),
    '{ reason, spec?, tldr?, changeSummary?, criteria } rewrites a draft revision whole',
  ),
  async (c) => {
    const { id, req, n } = c.req.valid('param');
    return answer(
      c,
      await writeRevision({
        projectId: id,
        ref: req,
        actor: actorOf(c),
        revision: n,
        write: c.req.valid('json'),
      }),
    );
  },
);

const emptyBody = strictBody(z.strictObject({}), 'this action takes an empty object');

requirementRoutes.post(
  '/:id/requirements/:req/revisions/:n/propose',
  revisionParam,
  emptyBody,
  async (c) => {
    const { id, req, n } = c.req.valid('param');
    return answer(
      c,
      await proposeRevision({ projectId: id, ref: req, actor: actorOf(c), revision: n }),
    );
  },
);

requirementRoutes.post(
  '/:id/requirements/:req/revisions/:n/accept',
  revisionParam,
  strictBody(acceptRevisionRequestSchema, ACCEPT_REVISION_SHAPE),
  async (c) => {
    const { id, req, n } = c.req.valid('param');
    return answer(
      c,
      await acceptRevision({
        projectId: id,
        ref: req,
        actor: actorOf(c),
        revision: n,
        reason: c.req.valid('json').reason,
      }),
    );
  },
);

requirementRoutes.post(
  '/:id/requirements/:req/revisions/:n/return',
  revisionParam,
  strictBody(z.strictObject({ reason: z.string().max(4_000) }), '{ reason } says why it went back'),
  async (c) => {
    const { id, req, n } = c.req.valid('param');
    return answer(
      c,
      await returnRevision({
        projectId: id,
        ref: req,
        actor: actorOf(c),
        revision: n,
        reason: c.req.valid('json').reason,
      }),
    );
  },
);

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

requirementRoutes.post(
  '/:id/requirements/:req/issues',
  reqParam,
  strictBody(
    z.strictObject({ issue: z.string().trim().min(1).max(200), adoptPlan: z.boolean().optional() }),
    '{ issue, adoptPlan? } names the issue, by key or uuid; adoptPlan (a person) records its existing plan as written against the current revision',
  ),
  async (c) => {
    const { id, req } = c.req.valid('param');
    return answer(
      c,
      await linkIssue({
        projectId: id,
        ref: req,
        actor: actorOf(c),
        issue: c.req.valid('json').issue,
        adoptPlan: c.req.valid('json').adoptPlan,
      }),
    );
  },
);

requirementRoutes.delete(
  '/:id/requirements/:req/issues/:issue',
  zValidator(
    'param',
    z.object({
      id: z.uuid(),
      req: z.string().trim().min(1).max(64),
      issue: z.string().trim().min(1).max(200),
    }),
    (r) => {
      if (!r.success) throw badRequest('invalid path: a project uuid, a requirement and an issue');
    },
  ),
  async (c) => {
    const { id, req, issue } = c.req.valid('param');
    return answer(c, await unlinkIssue({ projectId: id, ref: req, actor: actorOf(c), issue }));
  },
);

requirementRoutes.post(
  '/:id/requirements/:req/workflows',
  reqParam,
  strictBody(
    z.strictObject({ workflowId: z.uuid() }),
    '{ workflowId } names a workflow of this project',
  ),
  async (c) => {
    const { id, req } = c.req.valid('param');
    return answer(
      c,
      await linkWorkflow({
        projectId: id,
        ref: req,
        actor: actorOf(c),
        workflowId: c.req.valid('json').workflowId,
      }),
    );
  },
);

requirementRoutes.delete(
  '/:id/requirements/:req/workflows/:workflowId',
  zValidator(
    'param',
    z.object({ id: z.uuid(), req: z.string().trim().min(1).max(64), workflowId: z.uuid() }),
    (r) => {
      if (!r.success)
        throw badRequest('invalid path: a project uuid, a requirement and a workflow uuid');
    },
  ),
  async (c) => {
    const { id, req, workflowId } = c.req.valid('param');
    return answer(
      c,
      await unlinkWorkflow({ projectId: id, ref: req, actor: actorOf(c), workflowId }),
    );
  },
);
