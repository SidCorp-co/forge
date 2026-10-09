import { REASON_TEXT_MAX } from '@forge/contracts/comments';
import {
  WRITE_KIND_SHAPE,
  WRITE_PICTURE_SHAPE,
  writeKindRequestSchema,
  writePictureRequestSchema,
} from '@forge/contracts/requirement-pictures';
import { ACCEPT_REVISION_SHAPE, acceptRevisionRequestSchema } from '@forge/contracts/requirements';
import { Hono } from 'hono';
import { z } from 'zod';
import { holdChatWrite } from '../middleware/chat-write-hold.js';
import { strictBody } from '../middleware/zod-validator.js';
import { acceptRevision } from './agree.js';
import { writeKind, writePicture } from './picture.js';
import {
  actorOf,
  answer,
  draftPictureFits,
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
    "{ baseRevision, reason, spec?, kind?: process | rule | screen | report | null, picture?: { kind, content, alt? } drawn with it (alt left out is written from the content), tldr?, changeSummary?, writtenLang?: en | vi, criteria: [{ code?, body, form? }] } — baseRevision is the head you read; kind left out is the head's",
  ),
  draftPictureFits('head'),
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
    "{ reason, spec?, kind?: process | rule | screen | report | null, picture?: { kind, content, alt? } drawn with it (alt left out is written from the content), tldr?, changeSummary?, writtenLang?: en | vi, criteria: [{ code?, body, form? }] } rewrites a draft revision whole; a code the draft or its base holds keeps that code, no code takes the next one; kind left out keeps the draft's",
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

// The revision's one picture (REQ-35): drawn or replaced whole, shown at once with no accept
revisionRoutes.put(
  '/:id/requirements/:req/revisions/:n/picture',
  revisionParam,
  strictBody(writePictureRequestSchema, WRITE_PICTURE_SHAPE),
  async (c) => {
    const { id, req, n } = c.req.valid('param');
    return answer(
      c,
      await writePicture({
        projectId: id,
        ref: req,
        actor: actorOf(c),
        revision: n,
        body: c.req.valid('json'),
      }),
    );
  },
);

revisionRoutes.put(
  '/:id/requirements/:req/revisions/:n/kind',
  revisionParam,
  strictBody(writeKindRequestSchema, WRITE_KIND_SHAPE),
  async (c) => {
    const { id, req, n } = c.req.valid('param');
    return answer(
      c,
      await writeKind({
        projectId: id,
        ref: req,
        actor: actorOf(c),
        revision: n,
        kind: c.req.valid('json').kind,
      }),
    );
  },
);
