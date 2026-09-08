import { Hono } from 'hono';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { answerAs, readQuestionFor } from './read.js';
import { QuestionRefused, voidQuestion } from './write.js';

export const questionRoutes = new Hono<{ Variables: AuthVars }>();
questionRoutes.use('/questions/*', requireAuth(), assertEmailVerified());

questionRoutes.get('/questions/:id', async (c) => {
  const seen = await readQuestionFor(c.req.param('id'), c.get('userId'));
  if (!seen) return c.json({ error: 'not found' }, 404);
  return c.json(seen);
});

// cm:guard the refusal is a 403 carrying the option's authority, never a silent no-op or a 200 with nothing written. A locked option that answers anyway is a lock drawn on the screen and nowhere else (ISS-964 criterion 15).
questionRoutes.post('/questions/:id/answer', async (c) => {
  const body = await c.req.json<{ optionId?: string }>().catch(() => ({}) as { optionId?: string });
  if (!body.optionId) return c.json({ error: 'optionId is required' }, 400);
  try {
    const out = await answerAs({
      questionId: c.req.param('id'),
      optionId: body.optionId,
      userId: c.get('userId'),
    });
    return c.json(out);
  } catch (e) {
    if (e instanceof QuestionRefused) return c.json({ error: e.message }, 403);
    throw e;
  }
});

questionRoutes.post('/questions/:id/void', async (c) => {
  const body = await c.req.json<{ reason?: string }>().catch(() => ({}) as { reason?: string });
  const seen = await readQuestionFor(c.req.param('id'), c.get('userId'));
  if (!seen) return c.json({ error: 'not found' }, 404);
  try {
    await voidQuestion({ questionId: c.req.param('id'), reason: body.reason ?? '' });
    return c.json({ ok: true });
  } catch (e) {
    if (e instanceof QuestionRefused) return c.json({ error: e.message }, 400);
    throw e;
  }
});
