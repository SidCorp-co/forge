// The session's REST twins of forge_support's reference acts (ISS-1252): each runs the act its MCP
// action runs (`acts.ts`), and admits only the room's own session under its current turn's token.

import {
  supportReferenceAddRequestSchema,
  supportReferenceCiteRequestSchema,
  supportReferenceProposeRequestSchema,
  supportReferencesRequestSchema,
} from '@forge/contracts/support-references';
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

export function mountReferenceSessionRoutes(app: Hono<{ Variables: AuthVars }>): void {
  app.post(
    '/:id/support/session/references',
    projectParam,
    SESSION_ONLY,
    strictBody(supportReferencesRequestSchema, '{ project?, area?, q? }'),
    (c) => act(c, c.req.valid('param').id, { action: 'references', ...c.req.valid('json') }),
  );
  app.post(
    '/:id/support/session/reference-adds',
    projectParam,
    SESSION_ONLY,
    strictBody(
      supportReferenceAddRequestSchema,
      '{ thread, message, project?, kind, url, why, areas, title?, priority?, followReleases?, shared? }',
    ),
    (c) => act(c, c.req.valid('param').id, { action: 'reference_add', ...c.req.valid('json') }),
  );
  app.post(
    '/:id/support/session/reference-citations',
    projectParam,
    SESSION_ONLY,
    strictBody(
      supportReferenceCiteRequestSchema,
      '{ source, ref, verdict: take | reject, why, about?, project? }',
    ),
    (c) => act(c, c.req.valid('param').id, { action: 'reference_cite', ...c.req.valid('json') }),
  );
  app.post(
    '/:id/support/session/reference-proposals',
    projectParam,
    SESSION_ONLY,
    strictBody(
      supportReferenceProposeRequestSchema,
      '{ kind, url, why, areas, evidence, title?, priority?, followReleases?, project? }',
    ),
    (c) => act(c, c.req.valid('param').id, { action: 'reference_propose', ...c.req.valid('json') }),
  );
}
