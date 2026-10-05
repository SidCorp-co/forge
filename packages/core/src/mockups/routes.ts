import {
  DECIDE_MOCKUP_SHAPE,
  decideMockupRequestSchema,
  listMockupsQuerySchema,
  PROPOSE_MOCKUP_SHAPE,
  proposeMockupRequestSchema,
} from '@forge/contracts/mockups';
import { type Context, Hono } from 'hono';
import { z } from 'zod';
import { setInertAttachmentHeaders } from '../lib/attachment-headers.js';
import { refused } from '../lib/refusal.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { invalid, strictBody, zValidator } from '../middleware/zod-validator.js';
import { getMockupAs, listMockupsAs, mockupBytes } from './list.js';
import type { MockupActor } from './read.js';
import {
  acceptMockup,
  type MockupOutcome,
  proposeMockup,
  returnMockup,
  withdrawMockup,
} from './service.js';

/** Mockups (MK-n, ISS-78), under `/api/projects/:id/mockups`. */
export const mockupRoutes = new Hono<{ Variables: AuthVars }>();

for (const path of ['/:id/mockups', '/:id/mockups/*']) {
  mockupRoutes.use(path, requireAuth(), assertEmailVerified());
}

const projectParam = zValidator(
  'param',
  z.object({ id: z.uuid() }),
  invalid('invalid path: the project id is a uuid'),
);

const mockupParam = zValidator(
  'param',
  z.object({ id: z.uuid(), mk: z.string().trim().min(1).max(64) }),
  invalid('invalid path: a project uuid and a mockup uuid or key (MK-n)'),
);

const listQuery = zValidator(
  'query',
  listMockupsQuerySchema,
  invalid('invalid query: exactly one of requirement=REQ-n, feedback=FB-n or issue=ISS-n'),
);

function actorOf(c: Context<{ Variables: AuthVars }>): MockupActor {
  const agency = c.get('agency');
  if (!agency) throw new Error('mockups: a request reached its handler without an auth gate');
  return { userId: c.get('userId'), agency };
}

function answer(c: Context, outcome: MockupOutcome) {
  if (!outcome.ok) return refused(c, outcome.refusals, 'MOCKUP_REFUSED');
  return c.json({ mockup: outcome.mockup }, outcome.created ? 201 : 200);
}

mockupRoutes.get('/:id/mockups', projectParam, listQuery, async (c) => {
  const { id } = c.req.valid('param');
  return c.json(await listMockupsAs(actorOf(c), id, c.req.valid('query')));
});

mockupRoutes.post(
  '/:id/mockups',
  projectParam,
  strictBody(proposeMockupRequestSchema, PROPOSE_MOCKUP_SHAPE),
  async (c) => {
    const { id } = c.req.valid('param');
    return answer(
      c,
      await proposeMockup({ projectId: id, actor: actorOf(c), body: c.req.valid('json') }),
    );
  },
);

mockupRoutes.get('/:id/mockups/:mk', mockupParam, async (c) => {
  const { id, mk } = c.req.valid('param');
  return c.json({ mockup: await getMockupAs(actorOf(c), id, mk) });
});

mockupRoutes.get('/:id/mockups/:mk/content', mockupParam, async (c) => {
  const { id, mk } = c.req.valid('param');
  const file = await mockupBytes(actorOf(c), id, mk);
  if (!file.ok) return refused(c, [file.refusal], 'MOCKUP_REFUSED');
  setInertAttachmentHeaders(c, file.row.mime, file.row.name);
  c.header('Cache-Control', 'private, no-store');
  return c.body(new Uint8Array(file.bytes), 200);
});

const decideBody = strictBody(decideMockupRequestSchema, DECIDE_MOCKUP_SHAPE);

mockupRoutes.post('/:id/mockups/:mk/accept', mockupParam, decideBody, async (c) => {
  const { id, mk } = c.req.valid('param');
  return answer(
    c,
    await acceptMockup({
      projectId: id,
      ref: mk,
      actor: actorOf(c),
      reason: c.req.valid('json').reason,
    }),
  );
});

mockupRoutes.post('/:id/mockups/:mk/return', mockupParam, decideBody, async (c) => {
  const { id, mk } = c.req.valid('param');
  return answer(
    c,
    await returnMockup({
      projectId: id,
      ref: mk,
      actor: actorOf(c),
      reason: c.req.valid('json').reason,
    }),
  );
});

mockupRoutes.post(
  '/:id/mockups/:mk/withdraw',
  mockupParam,
  strictBody(z.strictObject({}), '{} (no fields)'),
  async (c) => {
    const { id, mk } = c.req.valid('param');
    return answer(c, await withdrawMockup({ projectId: id, ref: mk, actor: actorOf(c) }));
  },
);
