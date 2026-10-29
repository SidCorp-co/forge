import {
  RECORD_REQUIREMENT_VERDICT_SHAPE,
  recordRequirementVerdictRequestSchema,
} from '@forge/contracts/requirements';
import { Hono } from 'hono';
import { refused } from '../lib/refusal.js';
import { strictBody } from '../middleware/zod-validator.js';
import { actorOf, type RequirementEnv, reqParam } from './route-kit.js';
import { listRequirementVerdicts, recordRequirementVerdict } from './verdicts.js';

// mounted on `routes.ts:requirementRoutes`, whose auth gate covers every requirement path: a business
// criterion judged on the running build at the requirement itself (ISS-588)
export const requirementVerdictRoutes = new Hono<RequirementEnv>();

requirementVerdictRoutes.post(
  '/:id/requirements/:req/verdicts',
  reqParam,
  strictBody(recordRequirementVerdictRequestSchema, RECORD_REQUIREMENT_VERDICT_SHAPE),
  async (c) => {
    const { id, req } = c.req.valid('param');
    const written = await recordRequirementVerdict({
      projectId: id,
      ref: req,
      actor: actorOf(c),
      deviceId: c.get('patDeviceId') ?? null,
      body: c.req.valid('json'),
    });
    if (!written.ok) return refused(c, written.refusals, 'REQUIREMENT_REFUSED');
    return c.json(
      { verdictId: written.verdictId, coverage: written.coverage, routed: written.routed },
      201,
    );
  },
);

requirementVerdictRoutes.get('/:id/requirements/:req/verdicts', reqParam, async (c) => {
  const { id, req } = c.req.valid('param');
  return c.json({
    verdicts: await listRequirementVerdicts({ projectId: id, ref: req, actor: actorOf(c) }),
  });
});
