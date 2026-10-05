import { Hono } from 'hono';
import { z } from 'zod';
import { db } from '../db/client.js';
import { refused } from '../lib/refusal.js';
import { envelopeOf } from '../lib/write-envelope.js';
import { type AuthVars, assertEmailVerified, requireAuth, restActor } from '../middleware/auth.js';
import { invalid, zValidator } from '../middleware/zod-validator.js';
import { actorFor, projectResource, requireCan } from '../permissions/index.js';
import { readApiPage } from './api-page.js';
import { heldEcosystem } from './ecosystem-service.js';
import {
  commitmentsSetter,
  type HeldInterface,
  loadInterface,
  writeInterface,
} from './interface-service.js';
import { listInterfaceRevisions } from './interface-store.js';
import { membershipDocument } from './membership-rules.js';
import { membershipsWhere } from './membership-store.js';
import type { CommitmentsSetter } from './provider-writer-rules.js';
import { serialiseRevisions } from './routes.js';
import { readEcosystems } from './store.js';

export const ecosystemProjectRoutes = new Hono<{ Variables: AuthVars }>();

for (const path of ['/:id/interface', '/:id/interface/*', '/:id/api-page', '/:id/ecosystems']) {
  ecosystemProjectRoutes.use(path, requireAuth(), assertEmailVerified());
}

const idParam = zValidator(
  'param',
  z.object({ id: z.uuid() }),
  invalid('invalid path: the project id is a uuid'),
);

const serialise = (held: HeldInterface, setBy: CommitmentsSetter | null) => ({
  declared: true as const,
  revision: held.revision,
  document: held.document,
  updatedBy: held.updatedBy,
  updatedAt: held.updatedAt.toISOString(),
  commitmentsSetBy: setBy,
});

ecosystemProjectRoutes.get('/:id/interface', idParam, async (c) => {
  const { id } = c.req.valid('param');
  await requireCan(actorFor(c.get('userId')), 'project.read', projectResource(id));
  const held = await loadInterface(id);
  return c.json(
    held
      ? serialise(held, await commitmentsSetter(id))
      : { declared: false, revision: null, document: null },
  );
});

ecosystemProjectRoutes.put(
  '/:id/interface',
  idParam,
  zValidator('json', z.unknown()),
  async (c) => {
    const { id } = c.req.valid('param');
    const actor = restActor(c);
    const { baseRevision, document } = envelopeOf(c.req.valid('json'));
    const outcome = await writeInterface({
      projectId: id,
      writer: { userId: actor.id, agency: actor.agency },
      baseRevision,
      raw: document,
    });
    if (!outcome.ok) return refused(c, outcome.refusals, 'ECOSYSTEM_REFUSED');
    const setBy = await commitmentsSetter(id);
    return c.json({ ...serialise(outcome.held, setBy), created: outcome.created });
  },
);

ecosystemProjectRoutes.get('/:id/interface/revisions', idParam, async (c) => {
  const { id } = c.req.valid('param');
  await requireCan(actorFor(c.get('userId')), 'project.read', projectResource(id));
  return c.json(serialiseRevisions(await listInterfaceRevisions(id)));
});

ecosystemProjectRoutes.get('/:id/api-page', idParam, async (c) =>
  c.json(await readApiPage(c.get('userId'), c.req.valid('param').id)),
);

ecosystemProjectRoutes.get('/:id/ecosystems', idParam, async (c) => {
  const { id } = c.req.valid('param');
  await requireCan(actorFor(c.get('userId')), 'project.read', projectResource(id));
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
