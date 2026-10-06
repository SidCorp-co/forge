import {
  CREATE_FEEDBACK_SHAPE,
  createFeedbackRequestSchema,
  FEEDBACK_ATTACHMENT_SHAPE,
  FEEDBACK_CLARIFICATION_SHAPE,
  FEEDBACK_EMPTY_SHAPE,
  FEEDBACK_PHASES,
  FEEDBACK_REASON_SHAPE,
  FEEDBACK_RETARGET_SHAPE,
  FEEDBACK_TRIAGE_SHAPE,
  FEEDBACK_VERIFY_SHAPE,
  type FeedbackResponse,
  feedbackAttachmentRequestSchema,
  feedbackClarificationRequestSchema,
  feedbackEmptyRequestSchema,
  feedbackReasonRequestSchema,
  feedbackRetargetRequestSchema,
  feedbackTriageSchema,
  feedbackVerifyRequestSchema,
  listFeedbackQuerySchema,
  PROMOTE_AGENT_REPORT_SHAPE,
  promoteAgentReportRequestSchema,
} from '@forge/contracts/feedback';
import { type Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { setInertAttachmentHeaders } from '../lib/attachment-headers.js';
import { refused } from '../lib/refusal.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { invalid, strictBody, zValidator } from '../middleware/zod-validator.js';
import { addAttachment, askClarification, attachmentBytes } from './attachments.js';
import { similarFeedbackAs } from './embeddings.js';
import { listFeedbackAs } from './list-read.js';
import { promoteAgentReport } from './promote.js';
import { detailAs, type FeedbackActor } from './read.js';
import { redactReporterData } from './redact.js';
import { retargetFeedback } from './retarget.js';
import {
  askReporterToVerify,
  createFeedback,
  type FeedbackOutcome,
  reopenFeedback,
  verifyFeedback,
} from './service.js';
import { triageFeedback } from './triage.js';

export const feedbackRoutes = new Hono<{ Variables: AuthVars }>();

for (const path of ['/:id/feedback', '/:id/feedback/*']) {
  feedbackRoutes.use(path, requireAuth(), assertEmailVerified());
}

const projectParam = zValidator(
  'param',
  z.object({ id: z.uuid() }),
  invalid('invalid path: the project id is a uuid'),
);

const itemParam = zValidator(
  'param',
  z.object({ id: z.uuid(), fb: z.string().trim().min(1).max(64) }),
  invalid('invalid path: a project uuid and a feedback uuid or key (FB-n)'),
);

const attachmentParam = zValidator(
  'param',
  z.object({ id: z.uuid(), fb: z.string().trim().min(1).max(64), aid: z.uuid() }),
  invalid('invalid path: a project uuid, a feedback key and an attachment uuid'),
);

function actorOf(c: Context<{ Variables: AuthVars }>): FeedbackActor {
  const agency = c.get('agency');
  if (!agency) throw new Error('feedback: a request reached its handler without an auth gate');
  return { userId: c.get('userId'), agency };
}

function answer(c: Context, outcome: FeedbackOutcome) {
  if (!outcome.ok) return refused(c, outcome.refusals, 'FEEDBACK_REFUSED');
  const body: FeedbackResponse & { effect?: unknown } = {
    feedback: outcome.feedback,
    ...(outcome.effect ? { effect: outcome.effect } : {}),
  };
  return c.json(body, outcome.created ? 201 : 200);
}

feedbackRoutes.get(
  '/:id/feedback',
  projectParam,
  zValidator(
    'query',
    listFeedbackQuerySchema,
    invalid(
      `invalid query: phase? (comma-separated: ${FEEDBACK_PHASES.join(', ')}), q?, requirement? (REQ-n)`,
    ),
  ),
  async (c) => {
    const q = c.req.valid('query');
    const out = await listFeedbackAs(actorOf(c), c.req.valid('param').id, {
      phases: q.phase,
      q: q.q,
      requirement: q.requirement,
    });
    return out.ok ? c.json(out.list) : refused(c, out.refusals, 'FEEDBACK_REFUSED');
  },
);

feedbackRoutes.post(
  '/:id/feedback',
  projectParam,
  strictBody(createFeedbackRequestSchema, CREATE_FEEDBACK_SHAPE),
  async (c) =>
    answer(
      c,
      await createFeedback({
        projectId: c.req.valid('param').id,
        actor: actorOf(c),
        request: c.req.valid('json'),
      }),
    ),
);

feedbackRoutes.post(
  '/:id/feedback/promote',
  projectParam,
  strictBody(promoteAgentReportRequestSchema, PROMOTE_AGENT_REPORT_SHAPE),
  async (c) => {
    const out = await promoteAgentReport({
      projectId: c.req.valid('param').id,
      actor: actorOf(c),
      request: c.req.valid('json'),
    });
    if (!out.ok) return refused(c, out.refusals, 'FEEDBACK_REFUSED');
    return c.json({ feedback: out.feedback, effect: out.effect }, 201);
  },
);

feedbackRoutes.get('/:id/feedback/:fb', itemParam, async (c) => {
  const { id, fb } = c.req.valid('param');
  const body: FeedbackResponse = { feedback: await detailAs(actorOf(c), id, fb) };
  return c.json(body);
});

feedbackRoutes.get('/:id/feedback/:fb/similar', itemParam, async (c) => {
  const { id, fb } = c.req.valid('param');
  return c.json(await similarFeedbackAs(actorOf(c), id, fb));
});

feedbackRoutes.post(
  '/:id/feedback/:fb/triage',
  itemParam,
  strictBody(feedbackTriageSchema, FEEDBACK_TRIAGE_SHAPE),
  async (c) => {
    const { id, fb } = c.req.valid('param');
    return answer(
      c,
      await triageFeedback({
        projectId: id,
        ref: fb,
        actor: actorOf(c),
        triage: c.req.valid('json'),
        channel: 'web',
      }),
    );
  },
);

feedbackRoutes.post(
  '/:id/feedback/:fb/retarget',
  itemParam,
  strictBody(feedbackRetargetRequestSchema, FEEDBACK_RETARGET_SHAPE),
  async (c) => {
    const { id, fb } = c.req.valid('param');
    return answer(
      c,
      await retargetFeedback({
        projectId: id,
        ref: fb,
        actor: actorOf(c),
        request: c.req.valid('json'),
      }),
    );
  },
);

feedbackRoutes.post(
  '/:id/feedback/:fb/verify',
  itemParam,
  strictBody(feedbackVerifyRequestSchema, FEEDBACK_VERIFY_SHAPE),
  async (c) => {
    const { id, fb } = c.req.valid('param');
    return answer(
      c,
      await verifyFeedback({
        projectId: id,
        ref: fb,
        actor: actorOf(c),
        note: c.req.valid('json').note,
      }),
    );
  },
);

feedbackRoutes.post(
  '/:id/feedback/:fb/verify-ask',
  itemParam,
  strictBody(feedbackEmptyRequestSchema, FEEDBACK_EMPTY_SHAPE),
  async (c) => {
    const { id, fb } = c.req.valid('param');
    return answer(c, await askReporterToVerify({ projectId: id, ref: fb, actor: actorOf(c) }));
  },
);

feedbackRoutes.post(
  '/:id/feedback/:fb/reopen',
  itemParam,
  strictBody(feedbackReasonRequestSchema, FEEDBACK_REASON_SHAPE),
  async (c) => {
    const { id, fb } = c.req.valid('param');
    return answer(
      c,
      await reopenFeedback({
        projectId: id,
        ref: fb,
        actor: actorOf(c),
        reason: c.req.valid('json').reason,
      }),
    );
  },
);

feedbackRoutes.post(
  '/:id/feedback/:fb/clarification',
  itemParam,
  strictBody(feedbackClarificationRequestSchema, FEEDBACK_CLARIFICATION_SHAPE),
  async (c) => {
    const { id, fb } = c.req.valid('param');
    const body = c.req.valid('json');
    return answer(
      c,
      await askClarification({
        projectId: id,
        ref: fb,
        actor: actorOf(c),
        prompt: body.prompt,
        needed: body.needed,
      }),
    );
  },
);

feedbackRoutes.post(
  '/:id/feedback/:fb/attachments',
  itemParam,
  strictBody(feedbackAttachmentRequestSchema, FEEDBACK_ATTACHMENT_SHAPE),
  async (c) => {
    const { id, fb } = c.req.valid('param');
    return answer(
      c,
      await addAttachment({ projectId: id, ref: fb, actor: actorOf(c), ...c.req.valid('json') }),
    );
  },
);

feedbackRoutes.get('/:id/feedback/:fb/attachments/:aid', attachmentParam, async (c) => {
  const { id, fb, aid } = c.req.valid('param');
  const actor = actorOf(c);
  const file = await attachmentBytes({
    projectId: id,
    ref: fb,
    attachmentId: aid,
    userId: actor.userId,
    agency: actor.agency,
  });
  if (!file) {
    throw new HTTPException(404, {
      message: `feedback ${fb} holds no attachment ${aid}`,
      cause: { code: 'NOT_FOUND' },
    });
  }
  if (!file.ok) return refused(c, [file.refusal], 'FEEDBACK_REFUSED');
  setInertAttachmentHeaders(c, file.mime, file.name);
  c.header('Cache-Control', 'private, no-store');
  return c.body(new Uint8Array(file.bytes), 200);
});

feedbackRoutes.delete('/:id/feedback/:fb/reporter-data', itemParam, async (c) => {
  const { id, fb } = c.req.valid('param');
  return answer(c, await redactReporterData({ projectId: id, ref: fb, actor: actorOf(c) }));
});
