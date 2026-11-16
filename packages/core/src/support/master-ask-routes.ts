// The doors of a room agent's ask of a master and of the picture they share (ISS-1243 items 14, 20,
// 21). The session's twins of `forge_support` `ask_master` and `in_flight` admit only the room's own
// session; a master reads the asks waiting on it and its rooms' open threads, and answers an ask, under
// its project's own grants.

import {
  supportAskerRequestSchema,
  supportGuideRequestSchema,
} from '@forge/contracts/support-channel';
import {
  supportAskMasterRequestSchema,
  supportInFlightRequestSchema,
  supportMasterAskAnswerRequestSchema,
  supportMasterAsksQuerySchema,
  supportRaiseOwedRequestSchema,
} from '@forge/contracts/support-master-ask';
import type { Hono } from 'hono';
import { z } from 'zod';
import { refused } from '../lib/refusal.js';
import type { AuthVars } from '../middleware/auth.js';
import { invalid, noQuery, strictBody, zValidator } from '../middleware/zod-validator.js';
import { requiresOnParam } from '../permissions/index.js';
import { answerMasterAsk, masterAsksOf } from './master-ask.js';
import { act, SESSION_ONLY } from './session-door.js';
import { agentThreadsOf } from './shared-picture.js';

const projectParam = zValidator(
  'param',
  z.object({ id: z.uuid() }),
  invalid('invalid path: the project id is a uuid'),
);
const askParam = zValidator(
  'param',
  z.object({ id: z.uuid(), askId: z.uuid() }),
  invalid('invalid path: a project uuid and an ask uuid'),
);

export function mountMasterAskRoutes(app: Hono<{ Variables: AuthVars }>): void {
  app.post(
    '/:id/support/session/master-asks',
    projectParam,
    SESSION_ONLY,
    strictBody(supportAskMasterRequestSchema, '{ thread, question, project? }'),
    (c) => act(c, c.req.valid('param').id, { action: 'ask_master', ...c.req.valid('json') }),
  );
  app.post(
    '/:id/support/session/owed-raises',
    projectParam,
    SESSION_ONLY,
    strictBody(supportRaiseOwedRequestSchema, '{ thread, text }'),
    (c) => act(c, c.req.valid('param').id, { action: 'raise_owed', ...c.req.valid('json') }),
  );
  // who wrote a member's message and the thread around it (ISS-1250), read on the agent's call
  app.post(
    '/:id/support/session/askers',
    projectParam,
    SESSION_ONLY,
    strictBody(supportAskerRequestSchema, '{ thread, message }'),
    (c) => act(c, c.req.valid('param').id, { action: 'asker', ...c.req.valid('json') }),
  );
  // the room agent's guide, as the project or its org keeps it, else Forge's (ISS-1251)
  app.post(
    '/:id/support/session/guide',
    projectParam,
    SESSION_ONLY,
    strictBody(supportGuideRequestSchema, '{}'),
    (c) => act(c, c.req.valid('param').id, { action: 'guide' }),
  );
  app.post(
    '/:id/support/session/in-flight',
    projectParam,
    SESSION_ONLY,
    strictBody(supportInFlightRequestSchema, '{ thread }'),
    (c) => act(c, c.req.valid('param').id, { action: 'in_flight', ...c.req.valid('json') }),
  );

  // the asks a room agent put to this project's master, each with its wait and whether it breached
  app.get(
    '/:id/support/master-asks',
    projectParam,
    requiresOnParam('project.read', 'id'),
    zValidator(
      'query',
      supportMasterAsksQuerySchema,
      invalid('query: state is open (the default) or all'),
    ),
    async (c) =>
      c.json(await masterAsksOf(c.req.valid('param').id, c.req.valid('query').state ?? 'open')),
  );
  app.post(
    '/:id/support/master-asks/:askId/answer',
    askParam,
    requiresOnParam('project.write', 'id'),
    strictBody(supportMasterAskAnswerRequestSchema, '{ answer }'),
    async (c) => {
      const { id, askId } = c.req.valid('param');
      const out = await answerMasterAsk(
        { userId: c.get('userId'), projectId: id },
        askId,
        c.req.valid('json').answer,
      );
      if (!out.ok) return refused(c, out.refusals, 'SUPPORT_REFUSED');
      return c.json(out.value);
    },
  );

  // the open threads of this project's rooms, with the promises, items and asks open in each
  app.get(
    '/:id/support/agent-threads',
    projectParam,
    requiresOnParam('project.read', 'id'),
    noQuery,
    async (c) => c.json(await agentThreadsOf(c.req.valid('param').id)),
  );
}
