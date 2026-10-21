import {
  carryAgentReportsRequestSchema,
  FORGE_FEEDBACK_SHAPE,
  forgeFeedbackRequestSchema,
} from '@forge/contracts/forge-feedback';
import { type Context, Hono } from 'hono';
import { z } from 'zod';
import { carryAgentReports } from '../feedback/index.js';
import { refused } from '../lib/refusal.js';
import { type AuthVars, assertEmailVerified, requireAuth, restActor } from '../middleware/auth.js';
import { requireAdmin } from '../middleware/require-admin.js';
import { invalid, strictBody, zValidator } from '../middleware/zod-validator.js';
import {
  type Answer,
  type ForgeDoorCaller,
  fencedProjectOfCredential,
  getForgeFeedback,
  listOwnForgeFeedback,
  submitForgeFeedback,
} from './service.js';

type Ctx = Context<{ Variables: AuthVars }>;

const REST_DOOR = {};

/**
 * The caller as the Forge door reads them: their own account, and the box and the one project their
 * credential is bound to, from which an agent's live job is read (`feedback/forge-source.ts`).
 */
function callerOf(c: Ctx): ForgeDoorCaller {
  return {
    userId: c.get('userId'),
    agency: restActor(c).agency,
    deviceId: c.get('patDeviceId') ?? null,
    boundProjectId: fencedProjectOfCredential(),
  };
}

function answer<T>(c: Ctx, out: Answer<T>, status: 200 | 201 = 200) {
  if (!out.ok) return refused(c, out.refusals, 'FORGE_FEEDBACK_REFUSED');
  return c.json(out.value as object, status);
}

/** `/api/forge/feedback`: feedback about Forge itself, filed from any project as the caller (REQ-47). */
export const forgeFeedbackRoutes = new Hono<{ Variables: AuthVars }>();
forgeFeedbackRoutes.use('*', requireAuth(), assertEmailVerified());

forgeFeedbackRoutes.post(
  '/',
  strictBody(forgeFeedbackRequestSchema, FORGE_FEEDBACK_SHAPE),
  async (c) => {
    const out = await submitForgeFeedback(callerOf(c), c.req.valid('json'), REST_DOOR);
    return answer(c, out, out.ok && out.value.created ? 201 : 200);
  },
);

forgeFeedbackRoutes.get('/', zValidator('query', z.strictObject({})), async (c) =>
  answer(c, await listOwnForgeFeedback(callerOf(c), REST_DOOR)),
);

const keyParam = z.object({
  key: z.string().regex(/^FB-\d{1,9}$/, 'a feedback item is named by its key, FB-n'),
});

forgeFeedbackRoutes.get(
  '/:key',
  zValidator('param', keyParam, invalid('invalid path: /api/forge/feedback/<FB-n>')),
  async (c) => answer(c, await getForgeFeedback(callerOf(c), c.req.valid('param').key, REST_DOOR)),
);

/** The carry of the retired agent reports into Forge feedback, an instance admin's act (REQ-47 BC-8). */
export const forgeFeedbackAdminRoutes = new Hono<{ Variables: AuthVars }>();
forgeFeedbackAdminRoutes.use(
  '/forge-feedback/*',
  requireAuth(),
  assertEmailVerified(),
  requireAdmin(),
);

forgeFeedbackAdminRoutes.post(
  '/forge-feedback/carry-agent-reports',
  strictBody(carryAgentReportsRequestSchema, '{ dryRun?: boolean }'),
  async (c) => {
    const out = await carryAgentReports({ dryRun: c.req.valid('json').dryRun ?? false });
    if (!out.ok) return refused(c, out.refusals, 'FORGE_FEEDBACK_REFUSED');
    return c.json(out.result);
  },
);
