import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { db } from '../db/client.js';
import { assertProjectAccess } from '../lib/authz.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { zValidator } from '../middleware/zod-validator.js';
import { envelopeOf, refused } from '../project-config/respond.js';
import { readApiPage } from './api-page.js';
import { heldEcosystem } from './ecosystem-service.js';
import { type HeldInterface, loadInterface, writeInterface } from './interface-service.js';
import { membershipDocument } from './membership-rules.js';
import { listInterfaceRevisions, membershipsWhere, readEcosystems } from './store.js';

export const ecosystemProjectRoutes = new Hono<{ Variables: AuthVars }>();

for (const path of ['/:id/interface', '/:id/interface/*', '/:id/api-page', '/:id/ecosystems']) {
  ecosystemProjectRoutes.use(path, requireAuth(), assertEmailVerified());
}

const idParam = zValidator('param', z.object({ id: z.uuid() }), (r) => {
  if (!r.success) {
    throw new HTTPException(400, {
      message: 'invalid path: the project id is a uuid',
      cause: { code: 'BAD_REQUEST' },
    });
  }
});

const serialise = (held: HeldInterface) => ({
  declared: true as const,
  revision: held.revision,
  document: held.document,
  updatedBy: held.updatedBy,
  updatedAt: held.updatedAt.toISOString(),
});

ecosystemProjectRoutes.get('/:id/interface', idParam, async (c) => {
  const { id } = c.req.valid('param');
  await assertProjectAccess(id, c.get('userId'), 'viewer');
  const held = await loadInterface(id);
  return c.json(held ? serialise(held) : { declared: false, revision: null, document: null });
});

ecosystemProjectRoutes.put(
  '/:id/interface',
  idParam,
  zValidator('json', z.unknown()),
  async (c) => {
    const { id } = c.req.valid('param');
    const userId = c.get('userId');
    await assertProjectAccess(id, userId, 'admin');
    const { baseRevision, document } = envelopeOf(c.req.valid('json'));
    const outcome = await writeInterface({ projectId: id, userId, baseRevision, raw: document });
    if (!outcome.ok) return refused(c, outcome.refusals);
    return c.json({ ...serialise(outcome.held), created: outcome.created });
  },
);

ecosystemProjectRoutes.get('/:id/interface/revisions', idParam, async (c) => {
  const { id } = c.req.valid('param');
  await assertProjectAccess(id, c.get('userId'), 'viewer');
  const revisions = await listInterfaceRevisions(id);
  return c.json({
    revisions: revisions.map((r) => ({
      revision: r.revision,
      document: r.document,
      writtenBy: r.writtenBy,
      writtenAt: r.writtenAt.toISOString(),
    })),
    returned: revisions.length,
  });
});

ecosystemProjectRoutes.get('/:id/api-page', idParam, async (c) =>
  c.json(await readApiPage(c.get('userId'), c.req.valid('param').id)),
);

ecosystemProjectRoutes.get('/:id/ecosystems', idParam, async (c) => {
  const { id } = c.req.valid('param');
  await assertProjectAccess(id, c.get('userId'), 'viewer');
  const memberships = await membershipsWhere({ projectIds: [id] });
  const ecos = new Map(
    (
      await readEcosystems(
        db,
        memberships.map((m) => m.ecosystemId),
      )
    ).map((e) => [e.id, heldEcosystem(e).document]),
  );
  return c.json({
    memberships: memberships.map((m) => {
      const eco = ecos.get(m.ecosystemId);
      return {
        id: m.id,
        document: membershipDocument(m),
        ecosystem: eco
          ? {
              id: m.ecosystemId,
              slug: eco.ecosystem.slug,
              name: eco.ecosystem.name,
              ...(eco.ecosystem.purpose ? { purpose: eco.ecosystem.purpose } : {}),
              steward: eco.ecosystem.steward,
              channel: eco.channel.code,
            }
          : null,
      };
    }),
    returned: memberships.length,
  });
});
