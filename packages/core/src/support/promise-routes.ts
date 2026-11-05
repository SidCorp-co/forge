// A room's promise to tell a person in their thread when an issue reaches an environment, by the
// project's own name for it (ISS-1012): the REST twin of `forge_support` `promise`. One the room
// cannot keep is refused by name.

import { supportPromiseRequestSchema } from '@forge/contracts/support';
import type { Hono } from 'hono';
import { z } from 'zod';
import type { AuthVars } from '../middleware/auth.js';
import { invalid, strictBody, zValidator } from '../middleware/zod-validator.js';
import { act, SESSION_ONLY } from './session-door.js';

const projectParam = zValidator(
  'param',
  z.object({ id: z.uuid() }),
  invalid('invalid path: the project id is a uuid'),
);

export function mountPromiseRoutes(app: Hono<{ Variables: AuthVars }>): void {
  app.post(
    '/:id/support/session/promises',
    projectParam,
    SESSION_ONLY,
    strictBody(supportPromiseRequestSchema, '{ thread, issue, environment, asker?, project? }'),
    (c) => act(c, c.req.valid('param').id, { action: 'promise', ...c.req.valid('json') }),
  );
}
