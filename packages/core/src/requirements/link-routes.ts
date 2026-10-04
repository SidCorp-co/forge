import {
  LINK_REQUIREMENT_CONTRACT_SHAPE,
  linkRequirementContractRequestSchema,
} from '@forge/contracts/requirements';
import {
  PUT_CRITERION_STEPS_SHAPE,
  putCriterionStepsRequestSchema,
} from '@forge/contracts/workflow-health';
import { Hono } from 'hono';
import { z } from 'zod';
import { strictBody } from '../middleware/zod-validator.js';
import { linkContract, unlinkContract } from './contract-links.js';
import { putCriterionSteps } from './criterion-steps.js';
import { linkIssue, linkWorkflow, unlinkIssue, unlinkWorkflow } from './issue-links.js';
import { actorOf, answer, type RequirementEnv, reqAnd, reqParam } from './route-kit.js';

export const requirementLinkRoutes = new Hono<RequirementEnv>();

requirementLinkRoutes.post(
  '/:id/requirements/:req/issues',
  reqParam,
  strictBody(
    z.strictObject({ issue: z.string().trim().min(1).max(200), adoptPlan: z.boolean().optional() }),
    '{ issue, adoptPlan? } names the issue, by key or uuid; adoptPlan (needs requirements.approve) records its existing plan as written against the current revision',
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

requirementLinkRoutes.delete(
  '/:id/requirements/:req/issues/:issue',
  reqAnd({ issue: z.string().trim().min(1).max(200) }, ' and an issue'),
  async (c) => {
    const { id, req, issue } = c.req.valid('param');
    return answer(c, await unlinkIssue({ projectId: id, ref: req, actor: actorOf(c), issue }));
  },
);

requirementLinkRoutes.post(
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

requirementLinkRoutes.post(
  '/:id/requirements/:req/contracts',
  reqParam,
  strictBody(linkRequirementContractRequestSchema, LINK_REQUIREMENT_CONTRACT_SHAPE),
  async (c) => {
    const { id, req } = c.req.valid('param');
    return answer(
      c,
      await linkContract({
        projectId: id,
        ref: req,
        actor: actorOf(c),
        contract: c.req.valid('json').contract,
      }),
    );
  },
);

requirementLinkRoutes.delete(
  '/:id/requirements/:req/contracts/:project/:contract',
  reqAnd(
    { project: z.string().trim().min(1).max(63), contract: z.string().trim().min(1).max(63) },
    ', and the contract as <project>/<contract>',
  ),
  async (c) => {
    const { id, req, project, contract } = c.req.valid('param');
    return answer(
      c,
      await unlinkContract({
        projectId: id,
        ref: req,
        actor: actorOf(c),
        contract: `${project}/${contract}`,
      }),
    );
  },
);

requirementLinkRoutes.delete(
  '/:id/requirements/:req/workflows/:workflowId',
  reqAnd({ workflowId: z.uuid() }, ' and a workflow uuid'),
  async (c) => {
    const { id, req, workflowId } = c.req.valid('param');
    return answer(
      c,
      await unlinkWorkflow({ projectId: id, ref: req, actor: actorOf(c), workflowId }),
    );
  },
);

requirementLinkRoutes.put(
  '/:id/requirements/:req/criteria/:code/steps',
  reqAnd({ code: z.string().regex(/^BC-[1-9][0-9]*$/) }, ' and a criterion code (BC-n)'),
  strictBody(putCriterionStepsRequestSchema, PUT_CRITERION_STEPS_SHAPE),
  async (c) => {
    const { id, req, code } = c.req.valid('param');
    return answer(
      c,
      await putCriterionSteps({
        projectId: id,
        ref: req,
        code,
        actor: actorOf(c),
        request: c.req.valid('json'),
      }),
    );
  },
);
