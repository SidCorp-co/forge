import { REASON_TEXT_MAX } from '@forge/contracts/comments';
import { ACCEPT_REVISION_SHAPE, acceptRevisionRequestSchema } from '@forge/contracts/requirements';
import { Hono } from 'hono';
import { z } from 'zod';
import { holdChatWrite } from '../middleware/chat-write-hold.js';
import { strictBody } from '../middleware/zod-validator.js';
import { acceptRevision } from './agree.js';
import {
  actorOf,
  answer,
  type RequirementEnv,
  reqParam,
  revisionFields,
  revisionParam,
} from './route-kit.js';
import { proposeRevision, returnRevision, writeRevision } from './service.js';

export const revisionRoutes = new Hono<RequirementEnv>();

revisionRoutes.post(
  '/:id/requirements/:req/revisions',
  reqParam,
  strictBody(
    z.strictObject({ baseRevision: z.number().int().min(1).nullable(), ...revisionFields }),
    '{ baseRevision, reason, spec?, tldr?, changeSummary?, writtenLang?: en | vi, criteria: [{ code?, body, form? }] } — baseRevision is the head you read',
  ),
  holdChatWrite('requirement_revision'),
  async (c) => {
    const { id, req } = c.req.valid('param');
    const { baseRevision, ...write } = c.req.valid('json');
    return answer(
      c,
      await writeRevision({ projectId: id, ref: req, actor: actorOf(c), baseRevision, write }),
    );
  },
);

revisionRoutes.put(
  '/:id/requirements/:req/revisions/:n',
  revisionParam,
  strictBody(
    z.strictObject(revisionFields),
    '{ reason, spec?, tldr?, changeSummary?, writtenLang?: en | vi, criteria: [{ code?, body, form? }] } rewrites a draft revision whole; a code the draft or its base holds keeps that code, no code takes the next one',
  ),
  async (c) => {
    const { id, req, n } = c.req.valid('param');
    return answer(
      c,
      await writeRevision({
        projectId: id,
        ref: req,
        actor: actorOf(c),
        revision: n,
        write: c.req.valid('json'),
      }),
    );
  },
);

const emptyBody = strictBody(z.strictObject({}), 'this action takes an empty object');

revisionRoutes.post(
  '/:id/requirements/:req/revisions/:n/propose',
  revisionParam,
  emptyBody,
  async (c) => {
    const { id, req, n } = c.req.valid('param');
    return answer(
      c,
      await proposeRevision({ projectId: id, ref: req, actor: actorOf(c), revision: n }),
    );
  },
);

revisionRoutes.post(
  '/:id/requirements/:req/revisions/:n/accept',
  revisionParam,
  strictBody(acceptRevisionRequestSchema, ACCEPT_REVISION_SHAPE),
  async (c) => {
    const { id, req, n } = c.req.valid('param');
    return answer(
      c,
      await acceptRevision({
        projectId: id,
        ref: req,
        actor: actorOf(c),
        revision: n,
        reason: c.req.valid('json').reason,
      }),
    );
  },
);

revisionRoutes.post(
  '/:id/requirements/:req/revisions/:n/return',
  revisionParam,
  strictBody(
    z.strictObject({ reason: z.string().max(REASON_TEXT_MAX) }),
    '{ reason } says why it went back',
  ),
  async (c) => {
    const { id, req, n } = c.req.valid('param');
    return answer(
      c,
      await returnRevision({
        projectId: id,
        ref: req,
        actor: actorOf(c),
        revision: n,
        reason: c.req.valid('json').reason,
      }),
    );
  },
);
