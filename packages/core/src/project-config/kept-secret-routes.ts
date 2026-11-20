// The credentials a project kept from its rooms (ISS-1372, `kept-secrets.ts`): listed by name, kind,
// sender and state for a project member, never by value; a pending one approved or discarded by a
// person holding project admin. A usable one is read at the acting door alone.

import { Hono } from 'hono';
import { z } from 'zod';
import { refused } from '../lib/refusal.js';
import { type AuthVars, assertEmailVerified, requireAuth, restActor } from '../middleware/auth.js';
import { invalid, noQuery, zValidator } from '../middleware/zod-validator.js';
import { requiresOnParam } from '../permissions/index.js';
import { actingSecretDoor } from './secret-value-door.js';
import { decideKept, type KeptEntry, keptEntries } from './kept-secrets.js';

export const keptSecretRoutes = new Hono<{ Variables: AuthVars }>();

for (const path of ['/:id/kept-secrets', '/:id/kept-secrets/*']) {
  keptSecretRoutes.use(path, requireAuth(), assertEmailVerified());
}

const NAME = /^[a-z][a-z0-9-]{0,62}$/;
const idParam = zValidator(
  'param',
  z.object({ id: z.uuid() }),
  invalid('invalid path: the project id is a uuid'),
);
const nameParam = zValidator(
  'param',
  z.object({ id: z.uuid(), name: z.string().regex(NAME) }),
  invalid('invalid path: a project uuid and a kept secret name matching ^[a-z][a-z0-9-]{0,62}$'),
);

const SAYS =
  'Credentials people handed over in this project’s rooms, kept in its vault and never shown here. A usable one is read by the project’s master and its runs at its valueAt door, each read audited; a pending one waits for a project admin’s approval and is destroyed unused at its expiry.';

const viewOf = (projectId: string, e: KeptEntry) => ({
  ...e,
  valueAt: e.state === 'usable' ? actingSecretDoor(projectId, e.ref) : null,
});

keptSecretRoutes.get(
  '/:id/kept-secrets',
  idParam,
  requiresOnParam('project.read', 'id'),
  noQuery,
  async (c) => {
    const { id } = c.req.valid('param');
    const kept = (await keptEntries(id)).map((e) => viewOf(id, e));
    return c.json({ kept, returned: kept.length, says: SAYS });
  },
);

for (const [method, path, decision] of [
  ['post', '/:id/kept-secrets/:name/approval', 'approve'],
  ['delete', '/:id/kept-secrets/:name', 'discard'],
] as const) {
  keptSecretRoutes[method](
    path,
    nameParam,
    requiresOnParam('project.admin', 'id'),
    noQuery,
    async (c) => {
      const { id, name } = c.req.valid('param');
      const actor = restActor(c);
      if (actor.agency === 'agent') {
        return refused(
          c,
          [
            {
              code: 'KEPT_SECRET_PERSON_ONLY',
              path: '/name',
              detail: `a kept credential is ${decision === 'approve' ? 'approved' : 'discarded'} by a person holding project admin, never by an agent's token: an agent would be granting itself the value. Nothing was changed.`,
            },
          ],
          'CONFIG_REFUSED',
        );
      }
      const decided = await decideKept({
        projectId: id,
        name,
        decision,
        actor: { id: actor.id, tokenId: actor.tokenId },
      });
      if (!decided.ok) {
        return refused(c, [{ code: decided.code, path: '/name', detail: decided.detail }], 'CONFIG_REFUSED');
      }
      return c.json(viewOf(id, decided.entry));
    },
  );
}
