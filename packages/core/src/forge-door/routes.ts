import {
  FEEDBACK_CONFIRM_WAIT_SHAPE,
  feedbackConfirmWaitRequestSchema,
} from '@forge/contracts/feedback';
import {
  carryAgentReportsRequestSchema,
  FORGE_FEEDBACK_SETTLE_SHAPE,
  FORGE_FEEDBACK_SHAPE,
  forgeFeedbackRequestSchema,
  forgeFeedbackSettleRequestSchema,
} from '@forge/contracts/forge-feedback';
import { type Context, Hono } from 'hono';
import { z } from 'zod';
import { carryAgentReports } from '../feedback/index.js';
import { refused } from '../lib/refusal.js';
import { type AuthVars, assertEmailVerified, requireAuth, restActor } from '../middleware/auth.js';
import { invalid, noQuery, strictBody, zValidator } from '../middleware/zod-validator.js';
import {
  requiresByRule,
  requiresInstanceAdmin,
  requiresNoPermission,
  requiresSelf,
} from '../permissions/index.js';
import {
  type Answer,
  claimForgeAnswers,
  type ForgeDoorCaller,
  fencedProjectOfCredential,
  getForgeFeedback,
  listOwnForgeFeedback,
  replyForgeFeedback,
  settleForgeFeedback,
  submitForgeFeedback,
  waitForgeFeedback,
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
  requiresSelf(
    "an item about Forge, filed as the caller's own into Forge's home project, which takes no permission there",
  ),
  strictBody(forgeFeedbackRequestSchema, FORGE_FEEDBACK_SHAPE),
  async (c) => {
    const out = await submitForgeFeedback(callerOf(c), c.req.valid('json'), REST_DOOR);
    return answer(c, out, out.ok && out.value.created ? 201 : 200);
  },
);

forgeFeedbackRoutes.get(
  '/',
  requiresSelf('the items the caller reported'),
  zValidator('query', z.strictObject({})),
  async (c) => answer(c, await listOwnForgeFeedback(callerOf(c), REST_DOOR)),
);

// the answers on the caller's own items none of its sessions was told, each told once (REQ-47 BC-11)
forgeFeedbackRoutes.post(
  '/answers/claim',
  requiresSelf("the answers on the caller's own items"),
  strictBody(z.strictObject({}), '{}'),
  async (c) => answer(c, await claimForgeAnswers(callerOf(c), REST_DOOR)),
);

// an item is read and settled by its row, as forge_feedback's get, verify, reopen and reply are:
// the reporter of an item, never a permission on Forge's home project (REQ-47 BC-3)
const SERVICE = 'forge-door/service.ts';
const ITEM_ROW =
  "the item's row decides: its reporter, an agent reporter's master, or a member of Forge's home project; another answers not found";
const ITEM_READ = requiresByRule(`${SERVICE}:getForgeFeedback`, ITEM_ROW);
const ITEM_SETTLE = requiresByRule(`${SERVICE}:settleForgeFeedback`, ITEM_ROW);
const ITEM_REPLY = requiresByRule(`${SERVICE}:replyForgeFeedback`, ITEM_ROW);

const keyParam = z.object({
  key: z.string().regex(/^FB-\d{1,9}$/, 'a feedback item is named by its key, FB-n'),
});

forgeFeedbackRoutes.get(
  '/:key',
  zValidator('param', keyParam, invalid('invalid path: /api/forge/feedback/<FB-n>')),
  ITEM_READ,
  noQuery,
  async (c) => answer(c, await getForgeFeedback(callerOf(c), c.req.valid('param').key, REST_DOOR)),
);

// the reporter confirms the shipped fix, or reopens it, with what it ran and saw (REQ-66 BC-8)
forgeFeedbackRoutes.post(
  '/:key/verify',
  zValidator('param', keyParam, invalid('invalid path: /api/forge/feedback/<FB-n>/verify')),
  ITEM_SETTLE,
  strictBody(forgeFeedbackSettleRequestSchema, FORGE_FEEDBACK_SETTLE_SHAPE),
  async (c) =>
    answer(
      c,
      await settleForgeFeedback(
        callerOf(c),
        c.req.valid('param').key,
        'verified',
        c.req.valid('json').evidence,
        REST_DOOR,
      ),
    ),
);

forgeFeedbackRoutes.post(
  '/:key/reopen',
  zValidator('param', keyParam, invalid('invalid path: /api/forge/feedback/<FB-n>/reopen')),
  ITEM_SETTLE,
  strictBody(forgeFeedbackSettleRequestSchema, FORGE_FEEDBACK_SETTLE_SHAPE),
  async (c) =>
    answer(
      c,
      await settleForgeFeedback(
        callerOf(c),
        c.req.valid('param').key,
        'reopened',
        c.req.valid('json').evidence,
        REST_DOOR,
      ),
    ),
);

// the reporter, or its master, records why the confirm waits and until when (ISS-902)
forgeFeedbackRoutes.post(
  '/:key/confirm-wait',
  zValidator('param', keyParam, invalid('invalid path: /api/forge/feedback/<FB-n>/confirm-wait')),
  // the item is the check: its reporter, or the master owed its agent reporter's confirm (ISS-880),
  // neither of which need be a member of the home project (REQ-47 BC-3)
  requiresNoPermission(
    "the item's own reporter, or the master of the project its agent reporter reported from",
  ),
  strictBody(feedbackConfirmWaitRequestSchema, FEEDBACK_CONFIRM_WAIT_SHAPE),
  async (c) => {
    const body = c.req.valid('json');
    return answer(
      c,
      await waitForgeFeedback(
        callerOf(c),
        c.req.valid('param').key,
        { ...body, until: new Date(body.until) },
        REST_DOOR,
      ),
    );
  },
);

// the reporter replies once to the item's answer, which sends it back to triage (REQ-47 BC-12)
forgeFeedbackRoutes.post(
  '/:key/reply',
  zValidator('param', keyParam, invalid('invalid path: /api/forge/feedback/<FB-n>/reply')),
  ITEM_REPLY,
  strictBody(forgeFeedbackSettleRequestSchema, FORGE_FEEDBACK_SETTLE_SHAPE),
  async (c) =>
    answer(
      c,
      await replyForgeFeedback(
        callerOf(c),
        c.req.valid('param').key,
        c.req.valid('json').evidence,
        REST_DOOR,
      ),
    ),
);

/** The carry of the retired agent reports into Forge feedback, an instance admin's act (REQ-47 BC-8). */
export const forgeFeedbackAdminRoutes = new Hono<{ Variables: AuthVars }>();
forgeFeedbackAdminRoutes.use(
  '/forge-feedback/*',
  requireAuth(),
  assertEmailVerified(),
  requiresInstanceAdmin(
    "a carry of every project's retired agent reports into Forge's home project, an operator's act",
  ),
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
