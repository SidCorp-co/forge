// A room agent's audit of its own reply (ISS-1250): the REST twin of support.audit under the session's
// door, and `GET /api/projects/:id/support/reply-verdicts`, where a project reader reads each audit its
// room agents kept, per bot and per room kind, with how many replies went unaudited.

import {
  REPLY_VERDICTS_SHAPE,
  replyVerdictsQuerySchema,
  supportAuditRequestSchema,
} from '@forge/contracts/support-reply-audit';
import type { Hono } from 'hono';
import { z } from 'zod';
import type { AuthVars } from '../../middleware/auth.js';
import { invalid, strictBody, zValidator } from '../../middleware/zod-validator.js';
import { requiresOnParam } from '../../permissions/index.js';
import { act, SESSION_ONLY } from '../session-door.js';
import { replyVerdictsOf } from './read.js';

const projectParam = zValidator(
  'param',
  z.object({ id: z.uuid() }),
  invalid('invalid path: the project id is a uuid'),
);

export function mountReplyVerdictRoutes(routes: Hono<{ Variables: AuthVars }>): void {
  routes.post(
    '/:id/support/session/audits',
    projectParam,
    SESSION_ONLY,
    strictBody(supportAuditRequestSchema, '{ thread, message, failed: [{ line, why }] }'),
    (c) => act(c, c.req.valid('param').id, { action: 'audit', ...c.req.valid('json') }),
  );
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
