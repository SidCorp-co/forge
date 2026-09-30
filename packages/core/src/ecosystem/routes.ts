import { type Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { zValidator } from '../middleware/zod-validator.js';
import { envelopeOf, refused } from '../project-config/respond.js';
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
import { listEcosystemRevisions } from './store.js';

export const ecosystemRoutes = new Hono<{ Variables: AuthVars }>();
export const membershipRoutes = new Hono<{ Variables: AuthVars }>();

for (const router of [ecosystemRoutes, membershipRoutes]) {
  router.use('*', requireAuth(), assertEmailVerified());
}

const idParam = zValidator('param', z.object({ id: z.uuid() }), (r) => {
  if (!r.success) {
    throw new HTTPException(400, {
      message: 'invalid path: the id is a uuid',
      cause: { code: 'BAD_REQUEST' },
    });
  }
});

export const serialiseEcosystem = (held: HeldEcosystem) => ({
  id: held.id,
  revision: held.revision,
  document: held.document,
  updatedBy: held.updatedBy,
  updatedAt: held.updatedAt.toISOString(),
});

export const serialiseMembership = (row: MembershipRow) => ({
  id: row.id,
  document: membershipDocument(row),
});

function answerEcosystem(c: Context, outcome: EcosystemOutcome) {
  if (!outcome.ok) return refused(c, outcome.refusals);
  return c.json({ ...serialiseEcosystem(outcome.held), created: outcome.created });
}

function answerMembership(c: Context, outcome: MembershipOutcome) {
  if (!outcome.ok) return refused(c, outcome.refusals);
  return c.json(serialiseMembership(outcome.membership));
}

ecosystemRoutes.post('/', zValidator('json', z.unknown()), async (c) => {
  const { baseRevision, document } = envelopeOf(c.req.valid('json'));
  if (baseRevision !== null) {
    return refused(c, [
      {
        code: 'STALE_BASE',
        path: '/baseRevision',
        detail: `this creates an ecosystem, which has no revision to base on; send baseRevision null, not ${baseRevision}.`,
      },
    ]);
  }
  return answerEcosystem(c, await createEcosystem({ userId: c.get('userId'), raw: document }));
});

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
  const revisions = await listEcosystemRevisions(eco.id);
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
  zValidator('json', z.strictObject({ project: z.uuid() }), (r) => {
    if (!r.success) {
      throw new HTTPException(400, {
        message: 'the body is { "project": <project uuid> } and nothing else',
        cause: { code: 'BAD_REQUEST' },
      });
    }
  }),
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

membershipRoutes.get('/:id', idParam, async (c) =>
  c.json(serialiseMembership(await readableMembership(c.get('userId'), c.req.valid('param').id))),
);

const reasonBody = zValidator(
  'json',
  z.strictObject({ reason: z.string().trim().min(1).max(500) }),
  (r, c) => {
    if (!r.success) {
      return refused(c, [
        {
          code: 'MEMBERSHIP_REASON_REQUIRED',
          path: '/reason',
          detail:
            'leaving or removing a membership says why: the body is { "reason": 1 to 500 characters }, and the reason is kept on the membership.',
        },
      ]);
    }
  },
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
