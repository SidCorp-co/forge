// The session's REST twin of forge_support's look act (ISS-1356): it runs the act its MCP action runs
// (`acts.ts`), and admits only the room's own session under its current turn's token.

import { SUPPORT_LOOK_SHAPE, supportLookRequestSchema } from '@forge/contracts/support-look';
import type { Hono } from 'hono';
import { z } from 'zod';
import type { AuthVars } from '../middleware/auth.js';
import { invalid, strictBody, zValidator } from '../middleware/zod-validator.js';
import { act, SESSION_ONLY } from './session-door.js';

export function mountLookSessionRoutes(app: Hono<{ Variables: AuthVars }>): void {
  app.post(
    '/:id/support/session/looks',
    zValidator(
      'param',
      z.object({ id: z.uuid() }),
      invalid('invalid path: the project id is a uuid'),
    ),
    SESSION_ONLY,
    strictBody(supportLookRequestSchema, SUPPORT_LOOK_SHAPE),
    (c) => act(c, c.req.valid('param').id, { action: 'look', ...c.req.valid('json') }),
  );
}
