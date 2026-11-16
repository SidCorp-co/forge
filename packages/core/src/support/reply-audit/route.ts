// `GET /api/projects/:id/support/reply-verdicts` (ISS-1250): a project reader reads the verdict on each
// room line its bots stored, per bot and per room kind.

import {
  REPLY_VERDICTS_SHAPE,
  replyVerdictsQuerySchema,
} from '@forge/contracts/support-reply-audit';
import type { Hono } from 'hono';
import { z } from 'zod';
import type { AuthVars } from '../../middleware/auth.js';
import { invalid, zValidator } from '../../middleware/zod-validator.js';
import { requiresOnParam } from '../../permissions/index.js';
import { replyVerdictsOf } from './read.js';

const projectParam = zValidator(
  'param',
  z.object({ id: z.uuid() }),
  invalid('invalid path: the project id is a uuid'),
);

export function mountReplyVerdictRoutes(routes: Hono<{ Variables: AuthVars }>): void {
  routes.get(
    '/:id/support/reply-verdicts',
    projectParam,
    requiresOnParam('project.read', 'id'),
    zValidator(
      'query',
      replyVerdictsQuerySchema,
      invalid(`invalid query: ${REPLY_VERDICTS_SHAPE}`),
    ),
    async (c) => c.json(await replyVerdictsOf(c.req.valid('param').id, c.req.valid('query'))),
  );
}
