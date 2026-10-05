import { Hono } from 'hono';
import { RULES } from '../lib/rate-limits.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rate-limit.js';
import { zValidator } from '../middleware/zod-validator.js';
import { actorFor, projectResource, requireCan } from '../permissions/index.js';
import { memoryFeedbackInputSchema, runMemoryFeedback } from './feedback-service.js';
import { runMemoryWrite, writeMemoryInputSchema } from './write-service.js';

export const memoryWriteRoutes = new Hono<{ Variables: AuthVars }>();
// rateLimit after requireAuth so the bucket keys on the authenticated user.
memoryWriteRoutes.use(
  '*',
  requireAuth(),
  assertEmailVerified(),
  rateLimit(() => RULES.memoryWrite, { name: 'memory-write' }),
);

memoryWriteRoutes.post('/', zValidator('json', writeMemoryInputSchema), async (c) => {
  const body = c.req.valid('json');
  const userId = c.get('userId');
  await requireCan(actorFor(userId), 'project.write', projectResource(body.projectId));

  return c.json(await runMemoryWrite(body), 201);
});

// Recall-feedback loop (ISS-603): where agents report the outcome of
// verifying a memory hit against live code. Shares the memory-write rate
// bucket — feedback is a write-path mutation.
memoryWriteRoutes.post('/feedback', zValidator('json', memoryFeedbackInputSchema), async (c) => {
  const body = c.req.valid('json');
  const userId = c.get('userId');
  await requireCan(actorFor(userId), 'project.write', projectResource(body.projectId));

  const result = await runMemoryFeedback(body);
  return c.json(result, result.found ? 200 : 404);
});
