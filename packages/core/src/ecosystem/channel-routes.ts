import { type Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { zValidator } from '../middleware/zod-validator.js';
import { refused } from '../project-config/respond.js';
import { uuid } from '../project-config/schema.js';
import type { ChannelOutcome } from './channel-act.js';
import { type ChannelNeed, channelRoleRefusal, writerOf } from './channel-author.js';
import { supersede, withdraw } from './channel-ends.js';
import { holdOrRelease } from './channel-holds.js';
import { inbox, outbox, readAs, threadAs } from './channel-read.js';
import { NUMBER_PATTERN } from './channel-schema.js';
import { createDraft, editDraft, submit } from './channel-service.js';
import { viewOf } from './channel-view.js';
import type { ChannelRefusalCode } from './refusals.js';

export const channelProjectRoutes = new Hono<{ Variables: AuthVars }>();

channelProjectRoutes.use('/:id/channel/*', requireAuth(), assertEmailVerified());

const badRequest = (message: string) =>
  new HTTPException(400, { message, cause: { code: 'BAD_REQUEST' } });

const projectParam = zValidator('param', z.object({ id: z.uuid() }), (r) => {
  if (!r.success) throw badRequest('invalid path: the project id is a uuid');
});

const docParam = zValidator('param', z.object({ id: z.uuid(), doc: z.uuid() }), (r) => {
  if (!r.success) throw badRequest('invalid path: the project and the document are uuids');
});

const refParam = zValidator(
  'param',
  z.object({ id: z.uuid(), ref: z.union([z.uuid(), z.string().regex(NUMBER_PATTERN)]) }),
  (r) => {
    if (!r.success) throw badRequest('invalid path: a document is named by its uuid or its number');
  },
);

const threadParam = zValidator(
  'param',
  z.object({ id: z.uuid(), number: z.string().regex(NUMBER_PATTERN) }),
  (r) => {
    if (!r.success) throw badRequest('invalid path: a conversation is named by its number');
  },
);

const draftFields = {
  type: z.unknown(),
  to: z.unknown(),
  subject: z.unknown(),
  dueBy: z.unknown().optional(),
  inReplyTo: z.unknown().optional(),
  body: z.unknown(),
};

const DRAFT_SHAPE =
  '{ type, to, subject, dueBy?, inReplyTo?, body }; core sets id, from, number, state, gate and the author';

const draftBody = zValidator('json', z.strictObject({ ecosystem: uuid(), ...draftFields }), (r) => {
  if (!r.success) throw badRequest(`a draft is { ecosystem: <uuid>, ...${DRAFT_SHAPE} }`);
});

const editBody = zValidator('json', z.strictObject(draftFields), (r) => {
  if (!r.success) throw badRequest(`an edit is ${DRAFT_SHAPE}`);
});

const reasonBody = (code: ChannelRefusalCode, act: string) =>
  zValidator('json', z.strictObject({ reason: z.string().trim().min(1).max(500) }), (r, c) => {
    if (!r.success) {
      return refused(c, [
        {
          code,
          path: '/reason',
          detail: `${act} says why: the body is { "reason": 1 to 500 characters }, and both sides read it.`,
        },
      ]);
    }
  });

const supersedeBody = zValidator(
  'json',
  z.strictObject({
    by: z.string().regex(NUMBER_PATTERN),
    reason: z.string().trim().min(1).max(500),
  }),
  (r, c) => {
    if (!r.success) {
      return refused(c, [
        {
          code: 'SUPERSEDE_WITHOUT_REASON',
          path: '/reason',
          detail:
            'a supersession names its replacement and says why: the body is { "by": <the number of the published replacement>, "reason": 1 to 500 characters }.',
        },
      ]);
    }
  },
);

const holdBody = zValidator('json', z.strictObject({ reason: z.string().optional() }), (r) => {
  if (!r.success) throw badRequest('a hold is { reason }, and a release is { reason? }');
});

function answer(c: Context, outcome: ChannelOutcome) {
  if (!outcome.ok) return refused(c, outcome.refusals);
  return c.json(viewOf(outcome.served));
}

async function mayAct(c: Context<{ Variables: AuthVars }>, projectId: string, need: ChannelNeed) {
  const refusal = await channelRoleRefusal(c.get('userId'), projectId, need);
  if (refusal) {
    throw new HTTPException(403, { message: refusal.detail, cause: { code: 'FORBIDDEN' } });
  }
}

async function writer(c: Context<{ Variables: AuthVars }>, projectId: string) {
  await mayAct(c, projectId, 'write');
  return writerOf(c);
}

channelProjectRoutes.post('/:id/channel/drafts', projectParam, draftBody, async (c) => {
  const { id } = c.req.valid('param');
  const { ecosystem, ...input } = c.req.valid('json');
  return answer(
    c,
    await createDraft({
      projectId: id,
      writer: await writer(c, id),
      ecosystemId: ecosystem,
      input,
    }),
  );
});

channelProjectRoutes.put('/:id/channel/documents/:doc', docParam, editBody, async (c) => {
  const { id, doc } = c.req.valid('param');
  return answer(
    c,
    await editDraft({
      projectId: id,
      documentId: doc,
      writer: await writer(c, id),
      input: c.req.valid('json'),
    }),
  );
});

channelProjectRoutes.post('/:id/channel/documents/:doc/submit', docParam, async (c) => {
  const { id, doc } = c.req.valid('param');
  return answer(c, await submit({ projectId: id, documentId: doc, writer: await writer(c, id) }));
});

channelProjectRoutes.post(
  '/:id/channel/documents/:doc/withdraw',
  docParam,
  reasonBody('WITHDRAW_WITHOUT_REASON', 'a withdrawal'),
  async (c) => {
    const { id, doc } = c.req.valid('param');
    return answer(
      c,
      await withdraw({
        projectId: id,
        documentId: doc,
        writer: await writer(c, id),
        reason: c.req.valid('json').reason,
      }),
    );
  },
);

channelProjectRoutes.post(
  '/:id/channel/documents/:doc/supersede',
  docParam,
  supersedeBody,
  async (c) => {
    const { id, doc } = c.req.valid('param');
    const { by, reason } = c.req.valid('json');
    return answer(
      c,
      await supersede({ projectId: id, documentId: doc, writer: await writer(c, id), by, reason }),
    );
  },
);

channelProjectRoutes.get('/:id/channel/documents/:ref', refParam, async (c) => {
  const { id, ref } = c.req.valid('param');
  await mayAct(c, id, 'read');
  const view = await readAs(id, ref);
  return c.json({ ...viewOf(view), side: view.side, hold: view.hold });
});

channelProjectRoutes.get('/:id/channel/inbox', projectParam, async (c) => {
  const { id } = c.req.valid('param');
  await mayAct(c, id, 'read');
  const entries = await inbox(id);
  return c.json({
    documents: entries.map((e) => ({
      ...viewOf(e),
      hold: e.hold,
      owesReply: e.owesReply,
      answered: e.answered,
      overdue: e.overdue,
    })),
    returned: entries.length,
  });
});

channelProjectRoutes.get('/:id/channel/outbox', projectParam, async (c) => {
  const { id } = c.req.valid('param');
  await mayAct(c, id, 'read');
  const views = await outbox(id);
  return c.json({
    documents: views.map((v) => ({ ...viewOf(v), hold: v.hold })),
    returned: views.length,
  });
});

channelProjectRoutes.get('/:id/channel/threads/:number', threadParam, async (c) => {
  const { id, number } = c.req.valid('param');
  await mayAct(c, id, 'read');
  const t = await threadAs(id, number);
  return c.json({
    thread: t.thread,
    documents: t.documents.map((v) => ({ ...viewOf(v), side: v.side })),
    holds: t.holds,
  });
});

const holdHandler =
  (action: 'hold' | 'release') =>
  async (
    c: Context<{ Variables: AuthVars }>,
    id: string,
    number: string,
    reason: string | undefined,
  ) => {
    await mayAct(c, id, 'read');
    const outcome = await holdOrRelease({
      sideProjectId: id,
      thread: number,
      action,
      writer: await writerOf(c),
      reason,
    });
    if (!outcome.ok) return refused(c, outcome.refusals);
    return c.json({ thread: number, held: outcome.held, hold: outcome.hold });
  };

const hold = holdHandler('hold');
const release = holdHandler('release');

channelProjectRoutes.post('/:id/channel/threads/:number/hold', threadParam, holdBody, (c) => {
  const { id, number } = c.req.valid('param');
  return hold(c, id, number, c.req.valid('json').reason);
});

channelProjectRoutes.post('/:id/channel/threads/:number/release', threadParam, holdBody, (c) => {
  const { id, number } = c.req.valid('param');
  return release(c, id, number, c.req.valid('json').reason);
});
