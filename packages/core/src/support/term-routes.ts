// The session's REST twin of forge_support's term act (ISS-1256): it runs the act its MCP action runs
// (`acts.ts`), and admits only the room's own session under its current turn's token.

import { supportTermRequestSchema } from '@forge/contracts/support-terms';
import type { Hono } from 'hono';
import { z } from 'zod';
import type { AuthVars } from '../middleware/auth.js';
import { invalid, strictBody, zValidator } from '../middleware/zod-validator.js';
import { act, SESSION_ONLY } from './session-door.js';

export function mountTermSessionRoutes(app: Hono<{ Variables: AuthVars }>): void {
  app.post(
    '/:id/support/session/terms',
    zValidator(
      'param',
      z.object({ id: z.uuid() }),
      invalid('invalid path: the project id is a uuid'),
    ),
    SESSION_ONLY,
    strictBody(
      supportTermRequestSchema,
      '{ thread, message, slug, title, means, module, quote, aliases?, anchor?, project? }',
    ),
    (c) => act(c, c.req.valid('param').id, { action: 'term', ...c.req.valid('json') }),
  );
}
