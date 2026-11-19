// The session's REST twin of forge_support's secret_link act (ISS-1328, ISS-1348): it runs the act its MCP
// action runs (`acts.ts`), and admits only the room's own session under its current turn's token.

import { supportSecretLinkRequestSchema } from '@forge/contracts/support';
import type { Hono } from 'hono';
import { z } from 'zod';
import type { AuthVars } from '../middleware/auth.js';
import { invalid, strictBody, zValidator } from '../middleware/zod-validator.js';
import { act, SESSION_ONLY } from './session-door.js';

export function mountSecretLinkSessionRoutes(app: Hono<{ Variables: AuthVars }>): void {
  app.post(
    '/:id/support/session/secret-links',
    zValidator(
      'param',
      z.object({ id: z.uuid() }),
      invalid('invalid path: the project id is a uuid'),
    ),
    SESSION_ONLY,
    strictBody(
      supportSecretLinkRequestSchema,
      '{ thread, project?, kind: variable, environment, key | kind: testing, profile, actor | service | kind: integration, provider; presign? }',
    ),
    (c) => act(c, c.req.valid('param').id, { action: 'secret_link', ...c.req.valid('json') }),
  );
}
