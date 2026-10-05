import { type Context, Hono } from 'hono';
import { z } from 'zod';
import { refused } from '../lib/refusal.js';
import { envelopeOf } from '../lib/write-envelope.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { invalid, zValidator } from '../middleware/zod-validator.js';
import { REGISTER_STATUSES, readRegister } from './channel-register.js';
import {
  createEcosystem,
  type EcosystemOutcome,
  type HeldEcosystem,
  writeEcosystem,
} from './ecosystem-service.js';
import { type MembershipRow, type MembershipVerb, membershipDocument } from './membership-rules.js';
import {
  invite,
  type MembershipOutcome,
  readableEcosystem,
  readableMembership,
  transition,
  visibleMemberships,
} from './membership-service.js';
import { membershipHistory } from './membership-store.js';
import { DOCUMENT_TYPES } from './schema.js';
import { listEcosystemRevisions, type StoredRevision } from './store.js';
import { readWorkspace } from './workspace-read.js';

export const ecosystemRoutes = new Hono<{ Variables: AuthVars }>();
export const membershipRoutes = new Hono<{ Variables: AuthVars }>();

for (const router of [ecosystemRoutes, membershipRoutes]) {
  router.use('*', requireAuth(), assertEmailVerified());
}

const idParam = zValidator(
  'param',
  z.object({ id: z.uuid() }),
  invalid('invalid path: the id is a uuid'),
);

const serialiseEcosystem = (held: HeldEcosystem) => ({
  id: held.id,
  revision: held.revision,
  document: held.document,
  updatedBy: held.updatedBy,
  updatedAt: held.updatedAt.toISOString(),
});

export const serialiseRevisions = (revisions: readonly StoredRevision[]) => ({
  revisions: revisions.map((r) => ({
    revision: r.revision,
    document: r.document,
    writtenBy: r.writtenBy,
    writtenAt: r.writtenAt.toISOString(),
  })),
  returned: revisions.length,
});

const serialiseMembership = (row: MembershipRow) => ({
  id: row.id,
  document: membershipDocument(row),
});

function answerEcosystem(c: Context, outcome: EcosystemOutcome) {
  if (!outcome.ok) return refused(c, outcome.refusals, 'ECOSYSTEM_REFUSED');
  return c.json({ ...serialiseEcosystem(outcome.held), created: outcome.created });
}

function answerMembership(c: Context, outcome: MembershipOutcome) {
  if (!outcome.ok) return refused(c, outcome.refusals, 'ECOSYSTEM_REFUSED');
  return c.json(serialiseMembership(outcome.membership));
}

ecosystemRoutes.post('/', zValidator('json', z.unknown()), async (c) => {
  const { baseRevision, document } = envelopeOf(c.req.valid('json'));
  if (baseRevision !== null) {
    return refused(
      c,
      [
        {
          code: 'STALE_BASE',
          path: '/baseRevision',
          detail: `this creates an ecosystem, which has no revision to base on; send baseRevision null, not ${baseRevision}.`,
        },
      ],
      'ECOSYSTEM_REFUSED',
    );
  }
  return answerEcosystem(c, await createEcosystem({ userId: c.get('userId'), raw: document }));
});

// cm:why the person's ecosystems, the invitations to their projects and every thread one of their projects sent or received, across ecosystems, in one read: the Ecosystem menu, the Threads inbox and the empty state all stand on it
ecosystemRoutes.get('/mine', async (c) => c.json(await readWorkspace(c.get('userId'))));

ecosystemRoutes.get('/:id', idParam, async (c) => {
  const { eco } = await readableEcosystem(c.get('userId'), c.req.valid('param').id);
  return c.json(serialiseEcosystem(eco));
});

ecosystemRoutes.put('/:id', idParam, zValidator('json', z.unknown()), async (c) => {
  const { baseRevision, document } = envelopeOf(c.req.valid('json'));
  return answerEcosystem(
    c,
    await writeEcosystem({
      id: c.req.valid('param').id,
      userId: c.get('userId'),
      baseRevision,
      raw: document,
    }),
  );
});

ecosystemRoutes.get('/:id/revisions', idParam, async (c) => {
  const { eco } = await readableEcosystem(c.get('userId'), c.req.valid('param').id);
  return c.json(serialiseRevisions(await listEcosystemRevisions(eco.id)));
});

ecosystemRoutes.get('/:id/members', idParam, async (c) => {
  const { memberships } = await visibleMemberships(c.get('userId'), c.req.valid('param').id);
  return c.json({
    memberships: memberships.map(serialiseMembership),
    returned: memberships.length,
  });
});

ecosystemRoutes.post(
  '/:id/invitations',
  idParam,
  zValidator(
    'json',
    z.strictObject({ project: z.uuid() }),
    invalid('the body is { "project": <project uuid> } and nothing else'),
  ),
  async (c) =>
    answerMembership(
      c,
      await invite({
        ecosystemId: c.req.valid('param').id,
        projectId: c.req.valid('json').project,
        userId: c.get('userId'),
      }),
    ),
);

membershipRoutes.get('/:id', idParam, async (c) => {
  const row = await readableMembership(c.get('userId'), c.req.valid('param').id);
  return c.json({ ...serialiseMembership(row), history: await membershipHistory(row.id) });
});

const reasonBody = zValidator(
  'json',
  z.strictObject({ reason: z.string().trim().min(1).max(500) }),
  invalid(
    'leaving or removing a membership says why: the body is { "reason": 1 to 500 characters }, and the reason is kept on the membership.',
    'MEMBERSHIP_REASON_REQUIRED',
  ),
);

async function move(c: Context, membershipId: string, verb: MembershipVerb, reason: string | null) {
  return answerMembership(
    c,
    await transition({ membershipId, verb, userId: c.get('userId'), reason }),
  );
}

membershipRoutes.post('/:id/accept', idParam, (c) =>
  move(c, c.req.valid('param').id, 'accept', null),
);

membershipRoutes.post('/:id/decline', idParam, (c) =>
  move(c, c.req.valid('param').id, 'decline', null),
);

membershipRoutes.post('/:id/leave', idParam, reasonBody, (c) =>
  move(c, c.req.valid('param').id, 'leave', c.req.valid('json').reason),
);

membershipRoutes.post('/:id/remove', idParam, reasonBody, (c) =>
  move(c, c.req.valid('param').id, 'remove', c.req.valid('json').reason),
);

const registerQuery = zValidator(
  'query',
  z.strictObject({
    status: z.enum(REGISTER_STATUSES).optional(),
    type: z.enum(DOCUMENT_TYPES).optional(),
    party: z.uuid().optional(),
    limit: z.coerce.number().int().min(1).max(500).default(200),
  }),
);

ecosystemRoutes.get('/:id/register', idParam, registerQuery, async (c) => {
  const { rows, total } = await readRegister(
    c.get('userId'),
    c.req.valid('param').id,
    c.req.valid('query'),
  );
  return c.json({ documents: rows, returned: rows.length, total });
});

export { channelProjectRoutes } from './channel-routes.js';
export { contractRoutes } from './contract/routes.js';
export { deviceChannelInboxRoutes } from './device-channel-inbox-routes.js';
export { busRoutes, linkProjectRoutes } from './link-routes.js';
export { ecosystemProjectRoutes } from './project-routes.js';
export { contractStandingRoutes } from './standing/routes.js';
