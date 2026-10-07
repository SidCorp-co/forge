import { Hono } from 'hono';
import { z } from 'zod';
import { RULES } from '../lib/rate-limits.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rate-limit.js';
import { zValidator } from '../middleware/zod-validator.js';
import { actorFor, projectResource, requireCan } from '../permissions/index.js';
import { memoryFeedbackInputSchema, runMemoryFeedback } from './feedback-service.js';
import {
  correctMemory,
  memoryCorrectInputSchema,
  memoryRetireInputSchema,
  retireMemory,
} from './person-acts.js';
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

  return c.json(await runMemoryWrite(body, { writtenBy: userId }), 201);
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

const memoryActQuery = z.object({ projectId: z.uuid() });
const memoryActParam = z.object({ memoryId: z.uuid() });

// MJ-1: a person corrects a memory's text, with a reason; the old body stays as a revision.
memoryWriteRoutes.post(
  '/:memoryId/correct',
  zValidator('param', memoryActParam),
  zValidator('query', memoryActQuery),
  zValidator('json', memoryCorrectInputSchema),
  async (c) => {
    const { memoryId } = c.req.valid('param');
    const { projectId } = c.req.valid('query');
    const body = c.req.valid('json');
    const userId = c.get('userId');
    await requireCan(actorFor(userId), 'project.write', projectResource(projectId));
    return c.json(await correctMemory({ projectId, memoryId, userId, ...body }));
  },
);

// MJ-1: a person retires a memory that is wrong or no longer useful, with a reason; nothing is deleted.
memoryWriteRoutes.post(
  '/:memoryId/retire',
  zValidator('param', memoryActParam),
  zValidator('query', memoryActQuery),
  zValidator('json', memoryRetireInputSchema),
  async (c) => {
    const { memoryId } = c.req.valid('param');
    const { projectId } = c.req.valid('query');
    const body = c.req.valid('json');
    const userId = c.get('userId');
    await requireCan(actorFor(userId), 'project.write', projectResource(projectId));
    return c.json(await retireMemory({ projectId, memoryId, userId, ...body }));
  },
);
