import {
  INTAKE_ANSWER_SHAPE,
  INTAKE_KEEP_SHAPE,
  type IntakeDraftResponse,
  intakeAnswerRequestSchema,
  intakeKeepRequestSchema,
} from '@forge/contracts/intake-drafts';
import { Hono } from 'hono';
import { z } from 'zod';
import { refused } from '../lib/refusal.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { invalid, noQuery, strictBody, zValidator } from '../middleware/zod-validator.js';
import { answerIntakeQuestion, keepRefusedRequest } from './acts.js';
import { readIntakeDraft } from './read.js';

/**
 * The intake assistant's draft of REQ-n or FB-n: `GET` reads it with its value check, `POST
 * …/answers` answers one of its questions, and `POST …/keep` keeps a requirement its check refused
 * (REQ-65 BC-3, BC-6).
 */
export const intakeRoutes = new Hono<{ Variables: AuthVars }>();

intakeRoutes.use('/:id/intake-drafts/*', requireAuth(), assertEmailVerified());

const param = zValidator(
  'param',
  z.object({ id: z.uuid(), ref: z.string().trim().min(1).max(64) }),
  invalid('invalid path: a project uuid and an item key, REQ-n or FB-n'),
);

function actorOf(c: { get(key: 'userId'): string; get(key: 'agency'): AuthVars['agency'] }) {
  const agency = c.get('agency');
  if (!agency) throw new Error('intake: a request reached its handler without an auth gate');
  return { userId: c.get('userId'), agency };
}

intakeRoutes.get('/:id/intake-drafts/:ref', param, noQuery, async (c) => {
  const { id: projectId, ref } = c.req.valid('param');
  const out = await readIntakeDraft({ projectId, ref, viewer: actorOf(c) });
  if (!out.ok) return refused(c, out.refusals, 'INTAKE_REF_INVALID');
  const body: IntakeDraftResponse = { draft: out.draft };
  return c.json(body);
});

intakeRoutes.post(
  '/:id/intake-drafts/:ref/answers',
  param,
  strictBody(intakeAnswerRequestSchema, INTAKE_ANSWER_SHAPE),
  async (c) => {
    const { id: projectId, ref } = c.req.valid('param');
    const out = await answerIntakeQuestion({
      projectId,
      ref,
      actor: actorOf(c),
      body: c.req.valid('json'),
    });
    if (!out.ok) return refused(c, out.refusals, 'INTAKE_QUESTION_UNKNOWN');
    const body: IntakeDraftResponse = { draft: out.draft };
    return c.json(body);
  },
);

intakeRoutes.post(
  '/:id/intake-drafts/:ref/keep',
  param,
  strictBody(intakeKeepRequestSchema, INTAKE_KEEP_SHAPE),
  async (c) => {
    const { id: projectId, ref } = c.req.valid('param');
    const out = await keepRefusedRequest({
      projectId,
      ref,
      actor: actorOf(c),
      body: c.req.valid('json'),
    });
    if (!out.ok) return refused(c, out.refusals, 'VALUE_CHECK_NOT_REFUSED');
    const body: IntakeDraftResponse = { draft: out.draft };
    return c.json(body);
  },
);
