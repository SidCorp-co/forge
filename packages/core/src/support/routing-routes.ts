// The session's REST twins of a room agent's routing acts (ISS-1243): the decision it records per
// message, an owner's approval attached to its item, a reached project's feedback read, and a need
// raised in the project's one technical channel. Each admits only the room's own session.

import { supportApproveRequestSchema, supportDecideRequestSchema } from '@forge/contracts/support';
import { operationsFeedbackRequestSchema } from '@forge/contracts/support-operations';
import { supportTechnicalRequestSchema } from '@forge/contracts/support-technical';
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

export function mountRoutingRoutes(app: Hono<{ Variables: AuthVars }>): void {
  app.post(
    '/:id/support/session/decisions',
    projectParam,
    SESSION_ONLY,
    strictBody(
      supportDecideRequestSchema,
      '{ thread, message?, decision, project?, signals, confidence, why }',
    ),
    (c) => act(c, c.req.valid('param').id, { action: 'decide', ...c.req.valid('json') }),
  );
  app.post(
    '/:id/support/session/approvals',
    projectParam,
    SESSION_ONLY,
    strictBody(supportApproveRequestSchema, '{ thread, message, feedback, project? }'),
    (c) => act(c, c.req.valid('param').id, { action: 'approve', ...c.req.valid('json') }),
  );
  app.post(
    '/:id/support/session/feedback',
    projectParam,
    SESSION_ONLY,
    strictBody(operationsFeedbackRequestSchema, '{ project, key? }'),
    (c) => act(c, c.req.valid('param').id, { action: 'feedback', ...c.req.valid('json') }),
  );
  app.post(
    '/:id/support/session/technical-needs',
    projectParam,
    SESSION_ONLY,
    strictBody(
      supportTechnicalRequestSchema,
      '{ thread, need: permission | approval | finding | ask, text }',
    ),
    (c) => act(c, c.req.valid('param').id, { action: 'technical', ...c.req.valid('json') }),
  );
}
