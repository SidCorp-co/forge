import {
  CREATE_FEEDBACK_SHAPE,
  createFeedbackRequestSchema,
  FEEDBACK_ATTACHMENT_SHAPE,
  FEEDBACK_CLARIFICATION_SHAPE,
  FEEDBACK_PHASES,
  FEEDBACK_REASON_SHAPE,
  FEEDBACK_ROUTE_WRITE_SHAPE,
  FEEDBACK_TRIAGE_SHAPE,
  FEEDBACK_VERIFY_SHAPE,
  type FeedbackResponse,
  feedbackAttachmentRequestSchema,
  feedbackClarificationRequestSchema,
  feedbackReasonRequestSchema,
  feedbackRouteWriteSchema,
  feedbackTriageSchema,
  feedbackVerifyRequestSchema,
  listFeedbackQuerySchema,
  PROMOTE_AGENT_REPORT_SHAPE,
  PROPOSE_FEEDBACK_TRIAGE_SHAPE,
  promoteAgentReportRequestSchema,
  proposeFeedbackTriageRequestSchema,
} from '@forge/contracts/feedback';
import type { SuggestionResponse } from '@forge/contracts/suggestions';
import { type Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { db } from '../db/client.js';
import { setInertAttachmentHeaders } from '../lib/attachment-headers.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { strictBody, zValidator } from '../middleware/zod-validator.js';
import { refused } from '../lib/refusal.js';
import { createSuggestion } from '../suggestions/service.js';
import { addAttachment, askClarification, attachmentBytes } from './attachments.js';
import { similarFeedbackAs } from './embeddings.js';
import { promoteAgentReport } from './promote.js';
import { detailAs, type FeedbackActor, listFeedbackAs, rowIn } from './read.js';
import {
  createFeedback,
  type FeedbackOutcome,
  redactReporterData,
  reopenFeedback,
  verifyFeedback,
} from './service.js';
import { routeFeedback, triageFeedback } from './triage.js';

export const feedbackRoutes = new Hono<{ Variables: AuthVars }>();

for (const path of ['/:id/feedback', '/:id/feedback/*']) {
  feedbackRoutes.use(path, requireAuth(), assertEmailVerified());
}

const badRequest = (message: string) =>
  new HTTPException(400, { message, cause: { code: 'BAD_REQUEST' } });

const projectParam = zValidator('param', z.object({ id: z.uuid() }), (r) => {
  if (!r.success) throw badRequest('invalid path: the project id is a uuid');
});

const itemParam = zValidator(
  'param',
  z.object({ id: z.uuid(), fb: z.string().trim().min(1).max(64) }),
  (r) => {
    if (!r.success)
      throw badRequest('invalid path: a project uuid and a feedback uuid or key (FB-n)');
  },
);

const attachmentParam = zValidator(
  'param',
  z.object({ id: z.uuid(), fb: z.string().trim().min(1).max(64), aid: z.uuid() }),
  (r) => {
    if (!r.success)
      throw badRequest('invalid path: a project uuid, a feedback key and an attachment uuid');
  },
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
  zValidator('query', listFeedbackQuerySchema, (r) => {
    if (!r.success)
      throw badRequest(
        `invalid query: phase? (comma-separated: ${FEEDBACK_PHASES.join(', ')}), q?, requirement? (REQ-n)`,
      );
  }),
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
  '/:id/feedback/:fb/triage-suggestions',
  itemParam,
  strictBody(proposeFeedbackTriageRequestSchema, PROPOSE_FEEDBACK_TRIAGE_SHAPE),
  async (c) => {
    const { id, fb } = c.req.valid('param');
    const actor = actorOf(c);
    const body = c.req.valid('json');
    const row = await rowIn(db, id, fb);
    const outcome = await createSuggestion({
      projectId: id,
      actor,
      producerKind: actor.agency === 'agent' ? 'agent' : 'person',
      producerId: actor.userId,
      kind: 'feedback_triage',
      target: { feedback: row.id },
      baseRevision: null,
      payload: body.triage,
      model: body.model ?? null,
    });
    if (!outcome.ok) return refused(c, outcome.refusals, 'FEEDBACK_REFUSED');
    const answerBody: SuggestionResponse = { suggestion: outcome.suggestion };
    return c.json(answerBody, 201);
  },
);

feedbackRoutes.post(
  '/:id/feedback/:fb/route',
  itemParam,
  strictBody(feedbackRouteWriteSchema, FEEDBACK_ROUTE_WRITE_SHAPE),
  async (c) => {
    const { id, fb } = c.req.valid('param');
    return answer(
      c,
      await routeFeedback({
        projectId: id,
        ref: fb,
        actor: actorOf(c),
        write: c.req.valid('json'),
        channel: 'web',
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
