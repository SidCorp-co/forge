import { Hono } from 'hono';
import { z } from 'zod';
import { db } from '../db/client.js';
import { refused } from '../lib/refusal.js';
import { envelopeOf } from '../lib/write-envelope.js';
import { type AuthVars, assertEmailVerified, requireAuth, restActor } from '../middleware/auth.js';
import { invalid, zValidator } from '../middleware/zod-validator.js';
import { actorFor, projectResource, requireCan } from '../permissions/index.js';
import { adoptVersion } from './adopt-service.js';
import { readApiPage } from './api-page.js';
import { readContractContext } from './contract/run-context-service.js';
import { heldEcosystem } from './ecosystem-service.js';
import { interfaceView, loadInterface, writeInterface } from './interface-service.js';
import { listInterfaceRevisions } from './interface-store.js';
import { membershipDocument } from './membership-rules.js';
import { membershipsWhere } from './membership-store.js';
import { ecosystemPeers } from './peer-read.js';
import { serialiseRevisions } from './routes.js';
import { CONTRACT_REF } from './schema.js';
import { readEcosystems } from './store.js';
import { CONTEXT_ARGS, CONTEXT_SHAPE } from './tool-args.js';

export const ecosystemProjectRoutes = new Hono<{ Variables: AuthVars }>();

for (const path of [
  '/:id/interface',
  '/:id/interface/*',
  '/:id/api-page',
  '/:id/ecosystems',
  '/:id/contract-context',
]) {
  ecosystemProjectRoutes.use(path, requireAuth(), assertEmailVerified());
}

const idParam = zValidator(
  'param',
  z.object({ id: z.uuid() }),
  invalid('invalid path: the project id is a uuid'),
);

ecosystemProjectRoutes.get('/:id/interface', idParam, async (c) => {
  const { id } = c.req.valid('param');
  await requireCan(actorFor(c.get('userId')), 'project.read', projectResource(id));
  return c.json(await interfaceView(id, await loadInterface(id)));
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
    return c.json({ ...(await interfaceView(id, outcome.held)), created: outcome.created });
  },
);

const ADOPT_BODY = z.strictObject({
  contract: z.string().regex(CONTRACT_REF),
  version: z.string().min(1).max(40),
});

// the consumer moves its consumption of an additive version and every link to it in one act; the requirements left stale are named for a person's re-pin, never re-pinned here
ecosystemProjectRoutes.post(
  '/:id/interface/adopt',
  idParam,
  zValidator(
    'json',
    ADOPT_BODY,
    invalid(
      'the body is { contract: <provider slug>/<contract slug>, version: the approved version to adopt }',
      'ECOSYSTEM_ARGUMENT_INVALID',
    ),
  ),
  async (c) => {
    const { id } = c.req.valid('param');
    const actor = restActor(c);
    const { contract, version } = c.req.valid('json');
    const outcome = await adoptVersion({
      projectId: id,
      writer: { userId: actor.id, agency: actor.agency },
      contract,
      version,
    });
    if (!outcome.ok) return refused(c, outcome.refusals, 'ECOSYSTEM_REFUSED');
    return c.json({
      ...(await interfaceView(id, outcome.held)),
      adopted: { contract, version },
      moved: outcome.moved,
      staleRequirements: outcome.staleRequirements,
    });
  },
);

ecosystemProjectRoutes.get('/:id/interface/revisions', idParam, async (c) => {
  const { id } = c.req.valid('param');
  await requireCan(actorFor(c.get('userId')), 'project.read', projectResource(id));
  return c.json(serialiseRevisions(await listInterfaceRevisions(id)));
});

// The REST twin of `forge_ecosystem action=context`: the contracts a run touching `paths` reaches.
ecosystemProjectRoutes.post(
  '/:id/contract-context',
  idParam,
  zValidator(
    'json',
    CONTEXT_ARGS,
    invalid(`the body is ${CONTEXT_SHAPE}`, 'ECOSYSTEM_ARGUMENT_INVALID'),
  ),
  async (c) => {
    const { id } = c.req.valid('param');
    await requireCan(actorFor(c.get('userId')), 'project.read', projectResource(id));
    const { paths, session } = c.req.valid('json');
    const read = await readContractContext(id, paths, session ?? null);
    if (!read.ok) return refused(c, read.refusals, 'ECOSYSTEM_REFUSED');
    const { ok: _ok, ...answer } = read;
    return c.json(answer);
  },
);

ecosystemProjectRoutes.get('/:id/api-page', idParam, async (c) =>
  c.json(await readApiPage(c.get('userId'), c.req.valid('param').id)),
);

ecosystemProjectRoutes.get('/:id/ecosystems', idParam, async (c) => {
  const { id } = c.req.valid('param');
  await requireCan(actorFor(c.get('userId')), 'project.read', projectResource(id));
  const memberships = await membershipsWhere({ projectIds: [id] });
  const ecosystemIds = memberships.map((m) => m.ecosystemId);
  const [rows, peers] = await Promise.all([
    readEcosystems(db, ecosystemIds),
    ecosystemPeers(id, ecosystemIds),
  ]);
  const ecos = new Map(rows.map((e) => [e.id, heldEcosystem(e).document]));
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
        peers: peers.get(m.ecosystemId) ?? [],
      };
    }),
    returned: memberships.length,
  });
});
