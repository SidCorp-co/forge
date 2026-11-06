import { RUN_CONTEXT_QUERY_SHAPE, runContextQuerySchema } from '@forge/contracts/run-context';
import { Hono } from 'hono';
import { z } from 'zod';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { invalid, zValidator } from '../middleware/zod-validator.js';
import { requiresOnParam } from '../permissions/index.js';
import { readRunContext } from './read.js';

/**
 * `GET /api/projects/:id/run-context` (ISS-1065): every rule, knowledge entry, lesson and memory
 * that reached a run session, or every run over an issue, and how and when each did, so a wrong
 * action can be traced to the text its agent was given.
 */
export const runContextRoutes = new Hono<{ Variables: AuthVars }>();

runContextRoutes.use('/:id/run-context', requireAuth(), assertEmailVerified());

runContextRoutes.get(
  '/:id/run-context',
  zValidator(
    'param',
    z.object({ id: z.uuid() }),
    invalid('invalid path: the project id is a uuid'),
  ),
  requiresOnParam('project.read', 'id'),
  zValidator('query', runContextQuerySchema, invalid(`invalid query: ${RUN_CONTEXT_QUERY_SHAPE}`)),
  async (c) => c.json(await readRunContext(c.req.valid('param').id, c.req.valid('query'))),
);
