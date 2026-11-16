// A room agent's audit of its own reply (ISS-1250): the REST twin of support.audit under the session's
// door, and `GET /api/projects/:id/support/reply-verdicts`, where a project reader reads each audit its
// room agents kept, per bot and per room kind, with how many replies went unaudited. A master's or
// run's audit of its own output (ISS-1251) is `POST /api/projects/:id/self-audits`, audit.self's twin.

import {
  REPLY_VERDICTS_SHAPE,
  replyVerdictsQuerySchema,
  SELF_AUDIT_SHAPE,
  selfAuditRequestSchema,
  supportAuditRequestSchema,
} from '@forge/contracts/support-reply-audit';
import type { Hono } from 'hono';
import { z } from 'zod';
import { RefusalError } from '../../lib/refusal.js';
import type { AuthVars } from '../../middleware/auth.js';
import { invalid, strictBody, zValidator } from '../../middleware/zod-validator.js';
import { requiresOnParam } from '../../permissions/index.js';
import { act, SESSION_ONLY } from '../session-door.js';
import { replyVerdictsOf } from './read.js';
import { auditOwnWork } from './self-audit.js';

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
  routes.post(
    '/:id/self-audits',
    projectParam,
    requiresOnParam('project.write', 'id'),
    strictBody(selfAuditRequestSchema, SELF_AUDIT_SHAPE),
    async (c) => {
      const agency = c.get('agency');
      if (!agency)
        throw new Error('self-audits: a request reached its handler without an auth gate');
      const out = await auditOwnWork(
        c.req.valid('param').id,
        { userId: c.get('userId'), agency },
        c.req.valid('json'),
      );
      if (!out.ok) throw new RefusalError(out.refusals, 'SELF_AUDIT_REFUSED');
      return c.json(out.value, out.value.already ? 200 : 201);
    },
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
