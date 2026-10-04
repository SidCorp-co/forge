import { type Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { refused } from '../lib/refusal.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { requireAdmin } from '../middleware/require-admin.js';
import { strictBody, zValidator } from '../middleware/zod-validator.js';
import { listAllDeadDeliveries, listDeadDeliveries } from './read.js';
import { type ReplayOutcome, replayAnyDelivery, replayDelivery } from './service.js';

const badRequest = (message: string) =>
  new HTTPException(400, { message, cause: { code: 'BAD_REQUEST' } });

const pageQuery = zValidator(
  'query',
  z.strictObject({
    limit: z.coerce.number().int().min(1).max(200).default(50),
    offset: z.coerce.number().int().min(0).default(0),
  }),
  (r) => {
    if (!r.success) throw badRequest('invalid query: limit? (1..200, 50 by default), offset? (0 or more)');
  },
);

const emptyBody = strictBody(z.strictObject({}), 'this action takes an empty object');

function answer(c: Context, outcome: ReplayOutcome) {
  if (!outcome.ok) return refused(c, outcome.refusals, 'OUTBOX_REFUSED');
  const { ok: _ok, ...body } = outcome;
  return c.json(body);
}

/** A project's dead deliveries, and the replay act, which needs `outbox.replay` on the project. */
export const outboxRoutes = new Hono<{ Variables: AuthVars }>();

outboxRoutes.use('/:id/outbox/*', requireAuth(), assertEmailVerified());

outboxRoutes.get(
  '/:id/outbox/dead',
  zValidator('param', z.object({ id: z.uuid() }), (r) => {
    if (!r.success) throw badRequest('invalid path: the project id is a uuid');
  }),
  pageQuery,
  async (c) => {
    const { limit, offset } = c.req.valid('query');
    return c.json(
      await listDeadDeliveries({
        userId: c.get('userId'),
        projectId: c.req.valid('param').id,
        limit,
        offset,
      }),
    );
  },
);

outboxRoutes.post(
  '/:id/outbox/deliveries/:did/replay',
  zValidator('param', z.object({ id: z.uuid(), did: z.uuid() }), (r) => {
    if (!r.success) throw badRequest('invalid path: a project uuid and a delivery uuid');
  }),
  emptyBody,
  async (c) => {
    const { id, did } = c.req.valid('param');
    return answer(
      c,
      await replayDelivery({ userId: c.get('userId'), projectId: id, deliveryId: did }),
    );
  },
);

/** Every dead delivery, project-less events' included, for platform admins. */
export const outboxAdminRoutes = new Hono<{ Variables: AuthVars }>();
outboxAdminRoutes.use('/outbox/*', requireAuth(), assertEmailVerified(), requireAdmin());

outboxAdminRoutes.get('/outbox/dead', pageQuery, async (c) => {
  const { limit, offset } = c.req.valid('query');
  return c.json(await listAllDeadDeliveries(limit, offset));
});

outboxAdminRoutes.post(
  '/outbox/deliveries/:did/replay',
  zValidator('param', z.object({ did: z.uuid() }), (r) => {
    if (!r.success) throw badRequest('invalid path: the delivery id is a uuid');
  }),
  emptyBody,
  async (c) => answer(c, await replayAnyDelivery(c.req.valid('param').did)),
);
