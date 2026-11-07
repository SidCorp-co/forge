import { Hono } from 'hono';
import { z } from 'zod';
import { RULES } from '../lib/rate-limits.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { holdChatWrite } from '../middleware/chat-write-hold.js';
import { rateLimit } from '../middleware/rate-limit.js';
import { zValidator } from '../middleware/zod-validator.js';
import { requireDeclaredOn, requiresOnResolved } from '../permissions/index.js';
import { memoryFeedbackInputSchema, runMemoryFeedback } from './feedback-service.js';
import {
  correctMemory,
  memoryCorrectInputSchema,
  memoryRetireInputSchema,
  memoryRetireManyInputSchema,
  memoryVerifyInputSchema,
  retireMemories,
  retireMemory,
  verifyMemories,
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

memoryWriteRoutes.post(
  '/',
  zValidator('json', writeMemoryInputSchema),
  requiresOnResolved('project.write', 'the project the body names as projectId'),
  holdChatWrite('memory_note'),
  async (c) => {
    const body = c.req.valid('json');
    const userId = c.get('userId');
    await requireDeclaredOn(body.projectId, userId, 'project.write');

    return c.json(await runMemoryWrite(body, { writtenBy: userId }), 201);
  },
);

// Recall-feedback loop (ISS-603): where agents report the outcome of
// verifying a memory hit against live code. Shares the memory-write rate
// bucket — feedback is a write-path mutation.
memoryWriteRoutes.post(
  '/feedback',
  zValidator('json', memoryFeedbackInputSchema),
  requiresOnResolved('project.write', 'the project the body names as projectId'),
  async (c) => {
    const body = c.req.valid('json');
    const userId = c.get('userId');
    await requireDeclaredOn(body.projectId, userId, 'project.write');

    const result = await runMemoryFeedback(body);
    return c.json(result, result.found ? 200 : 404);
  },
);

const memoryActQuery = z.object({ projectId: z.uuid() });
const memoryActParam = z.object({ memoryId: z.uuid() });

// MJ-1: a person corrects a memory's text, with a reason; the old body stays as a revision.
memoryWriteRoutes.post(
  '/:memoryId/correct',
  zValidator('param', memoryActParam),
  zValidator('query', memoryActQuery),
  zValidator('json', memoryCorrectInputSchema),
  requiresOnResolved('project.write', 'the project the query names as projectId'),
  async (c) => {
    const { memoryId } = c.req.valid('param');
    const { projectId } = c.req.valid('query');
    const body = c.req.valid('json');
    const userId = c.get('userId');
    await requireDeclaredOn(projectId, userId, 'project.write');
    return c.json(await correctMemory({ projectId, memoryId, userId, ...body }));
  },
);

// A person says "still true" of one memory or many: each is stamped checked now, by them.
memoryWriteRoutes.post(
  '/verify',
  zValidator('query', memoryActQuery),
  zValidator('json', memoryVerifyInputSchema),
  requiresOnResolved('project.write', 'the project the query names as projectId'),
  async (c) => {
    const { projectId } = c.req.valid('query');
    const { ids } = c.req.valid('json');
    const userId = c.get('userId');
    await requireDeclaredOn(projectId, userId, 'project.write');
    return c.json(await verifyMemories({ projectId, memoryIds: ids, userId }));
  },
);

// MJ-1: a person retires a memory that is wrong or no longer useful, with a reason; nothing is deleted.
memoryWriteRoutes.post(
  '/:memoryId/retire',
  zValidator('param', memoryActParam),
  zValidator('query', memoryActQuery),
  zValidator('json', memoryRetireInputSchema),
  requiresOnResolved('project.write', 'the project the query names as projectId'),
  async (c) => {
    const { memoryId } = c.req.valid('param');
    const { projectId } = c.req.valid('query');
    const body = c.req.valid('json');
    const userId = c.get('userId');
    await requireDeclaredOn(projectId, userId, 'project.write');
    return c.json(await retireMemory({ projectId, memoryId, userId, ...body }));
  },
);

// Many memories retired in one call under one reason, each answered retired or refused by name: a
// sweep of stale notes spends one write, never one per row.
memoryWriteRoutes.post(
  '/retire',
  zValidator('query', memoryActQuery),
  zValidator('json', memoryRetireManyInputSchema),
  requiresOnResolved('project.write', 'the project the query names as projectId'),
  async (c) => {
    const { projectId } = c.req.valid('query');
    const { ids, reason } = c.req.valid('json');
    const userId = c.get('userId');
    await requireDeclaredOn(projectId, userId, 'project.write');
    return c.json(await retireMemories({ projectId, memoryIds: ids, userId, reason }));
  },
);
