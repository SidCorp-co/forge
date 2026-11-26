// The session's REST twin of forge_support's react act (ISS-1475): it runs the act its MCP action
// runs (`acts.ts`), and admits only the room's own session under its current turn's token.

import { SUPPORT_REACT_SHAPE, supportReactRequestSchema } from '@forge/contracts/support-react';
import type { Hono } from 'hono';
import { z } from 'zod';
import type { AuthVars } from '../middleware/auth.js';
import { invalid, strictBody, zValidator } from '../middleware/zod-validator.js';
import { act, SESSION_ONLY } from './session-door.js';

export function mountReactSessionRoutes(app: Hono<{ Variables: AuthVars }>): void {
  app.post(
    '/:id/support/session/reactions',
    zValidator(
      'param',
      z.object({ id: z.uuid() }),
      invalid('invalid path: the project id is a uuid'),
    ),
    SESSION_ONLY,
    strictBody(supportReactRequestSchema, SUPPORT_REACT_SHAPE),
    (c) => act(c, c.req.valid('param').id, { action: 'react', ...c.req.valid('json') }),
  );
}
