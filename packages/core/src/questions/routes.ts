// The human's side of a parked decision: read one, list an issue's, answer one, void one.
//
// Every refusal here leaves as `{ code, message }`, the body `middleware/error.ts`
// builds for every other route, because the browser's `formatApiError` reads
// `code` first and `message` second and can read neither out of a hand-rolled
// `{ error }` (ISS-980 criterion 40).

import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { z } from 'zod';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { answerAs, readQuestionFor, readQuestionsForIssue } from './read.js';
import { type QuestionRefusalCode, QuestionRefused, voidQuestion } from './write.js';

const uuid = z.uuid();

const badRequest = (message: string) =>
  new HTTPException(400, { message, cause: { code: 'BAD_REQUEST' } });

const notFound = () =>
  new HTTPException(404, { message: 'question not found', cause: { code: 'NOT_FOUND' } });

// cm:guard the status is a property of the REFUSAL and not of the verb: a stale round and an already-answered question are conflicts a refresh settles, an unknown option is a malformed request, and only authority is a permission. Collapsing them back to one 403 tells a caller to go and ask for access when what it owes is a reload (ISS-980 criterion 40).
const REFUSAL_STATUS: Record<QuestionRefusalCode, ContentfulStatusCode> = {
  QUESTION_REFUSED: 403,
  QUESTION_NOT_FOUND: 404,
  QUESTION_NOT_OPEN: 409,
  QUESTION_EXPIRED: 409,
  QUESTION_ROUND_STALE: 409,
  QUESTION_OPTION_UNKNOWN: 400,
  QUESTION_AUTHORITY_REQUIRED: 403,
  QUESTION_REASON_REQUIRED: 400,
};

const refused = (e: QuestionRefused) =>
  new HTTPException(REFUSAL_STATUS[e.code], { message: e.message, cause: { code: e.code } });

export const questionRoutes = new Hono<{ Variables: AuthVars }>();
// cm:guard BOTH mounts, because Hono's `/questions/*` does not match the bare `/questions` the issue-scoped list is served on — drop this line and that list answers every caller before any auth middleware runs.
questionRoutes.use('/questions', requireAuth(), assertEmailVerified());
questionRoutes.use('/questions/*', requireAuth(), assertEmailVerified());

questionRoutes.get('/questions', async (c) => {
  const issueId = c.req.query('issueId');
  if (!issueId) throw badRequest('issueId is required');
  // cm:guard the uuid is checked BEFORE the query reaches postgres: `issue_id` is a uuid column and a malformed literal raises 22P02, which leaves the handler as a 500 — a caller's typo must not read as a server fault.
  if (!uuid.safeParse(issueId).success) throw badRequest('issueId must be a uuid');
  const seen = await readQuestionsForIssue(issueId, c.get('userId'));
  if (!seen) throw notFound();
  return c.json({ questions: seen });
});

questionRoutes.get('/questions/:id', async (c) => {
  const seen = await readQuestionFor(c.req.param('id'), c.get('userId'));
  if (!seen) throw notFound();
  return c.json(seen);
});

// cm:guard the refusal is a coded status carrying the option's authority, never a silent no-op or a 200 with nothing written. A locked option that answers anyway is a lock drawn on the screen and nowhere else (ISS-964 criterion 15).
// cm:guard `round` is REQUIRED and is never defaulted to the question's current round: the answer binds to the round the person was shown, and defaulting it applies a choice made about round 1 to a round 3 they never read (ISS-980 criterion 39).
questionRoutes.post('/questions/:id/answer', async (c) => {
  const body = await c.req
    .json<{ optionId?: string; round?: number }>()
    .catch(() => ({}) as { optionId?: string; round?: number });
  if (!body.optionId) throw badRequest('optionId is required');
  if (!Number.isInteger(body.round)) throw badRequest('round is required, as an integer');
  try {
    return c.json(
      await answerAs({
        questionId: c.req.param('id'),
        optionId: body.optionId,
        round: body.round as number,
        userId: c.get('userId'),
      }),
    );
  } catch (e) {
    if (e instanceof QuestionRefused) throw refused(e);
    throw e;
  }
});

questionRoutes.post('/questions/:id/void', async (c) => {
  const body = await c.req.json<{ reason?: string }>().catch(() => ({}) as { reason?: string });
  const seen = await readQuestionFor(c.req.param('id'), c.get('userId'));
  if (!seen) throw notFound();
  try {
    await voidQuestion({ questionId: c.req.param('id'), reason: body.reason ?? '' });
    return c.json({ ok: true });
  } catch (e) {
    if (e instanceof QuestionRefused) throw refused(e);
    throw e;
  }
});
