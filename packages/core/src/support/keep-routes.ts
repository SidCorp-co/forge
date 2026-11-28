// The session's REST twin of forge_support's keep act (ISS-1485): it runs the act its MCP action runs
// (`acts.ts`), and admits only the room's own session under its current turn's token.

import { supportKeepRequestSchema } from '@forge/contracts/support-keep';
import type { Hono } from 'hono';
import { z } from 'zod';
import type { AuthVars } from '../middleware/auth.js';
import { invalid, strictBody, zValidator } from '../middleware/zod-validator.js';
import { act, SESSION_ONLY } from './session-door.js';

export function mountKeepSessionRoutes(app: Hono<{ Variables: AuthVars }>): void {
  app.post(
    '/:id/support/session/keeps',
    zValidator(
      'param',
      z.object({ id: z.uuid() }),
      invalid('invalid path: the project id is a uuid'),
    ),
    SESSION_ONLY,
    strictBody(
      supportKeepRequestSchema,
      '{ thread, topic, concerns, title, learned, scope, recheckWhen, project? }',
    ),
    (c) => act(c, c.req.valid('param').id, { action: 'keep', ...c.req.valid('json') }),
  );
}
