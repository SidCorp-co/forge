import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { RULES } from '../config/rate-limits.js';
import { EMBEDDING_UNAVAILABLE, EmbeddingUnavailableError } from '../embeddings/index.js';
import { assertProjectAccess } from '../lib/authz.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rate-limit.js';
import {
  MemoryFeedbackValidationError,
  memoryFeedbackInputSchema,
  runMemoryFeedback,
} from './feedback-service.js';
import { runMemoryWrite, writeMemoryInputSchema } from './write-service.js';

const badRequest = (details: unknown) =>
  new HTTPException(400, { message: 'Invalid input', cause: { code: 'BAD_REQUEST', details } });

export const memoryWriteRoutes = new Hono<{ Variables: AuthVars }>();
// rateLimit after requireAuth so the bucket keys on the authenticated user.
memoryWriteRoutes.use(
  '*',
  requireAuth(),
  assertEmailVerified(),
  rateLimit(RULES.memoryWrite, { name: 'memory-write' }),
);

memoryWriteRoutes.post(
  '/',
  zValidator('json', writeMemoryInputSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const body = c.req.valid('json');
    const userId = c.get('userId');
    await assertProjectAccess(body.projectId, userId);

    try {
      const result = await runMemoryWrite(body);
      return c.json(result, 201);
    } catch (err) {
      if (err instanceof EmbeddingUnavailableError) {
        throw new HTTPException(503, {
          message: 'embeddings service unavailable',
          cause: { code: EMBEDDING_UNAVAILABLE },
        });
      }
      throw err;
    }
  },
);

// Recall-feedback loop (ISS-603): where agents report the outcome of
// verifying a memory hit against live code. Shares the memory-write rate
// bucket — feedback is a write-path mutation.
memoryWriteRoutes.post(
  '/feedback',
  zValidator('json', memoryFeedbackInputSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const body = c.req.valid('json');
    const userId = c.get('userId');
    await assertProjectAccess(body.projectId, userId);

    try {
      const result = await runMemoryFeedback(body);
      return c.json(result, result.found ? 200 : 404);
    } catch (err) {
      if (err instanceof MemoryFeedbackValidationError) {
        throw badRequest({ evidence: [err.message] });
      }
      throw err;
    }
  },
);
