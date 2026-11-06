// A project's secrets by name: listed, written (with the sign-in check an actor's secret gets,
// ISS-937), removed, and a value guessed at any of their paths refused naming the one door a
// running judge reads it at. A person reads a secret's name here and its value nowhere.

import { secretRefOf } from '@forge/contracts/project-config';
import { SUPPORT_OWNER_CREDENTIAL_SCOPE } from '@forge/contracts/support';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { VARIABLE_SECRET_SCOPE } from '../db/schema-project-variables.js';
import { refused } from '../lib/refusal.js';
import { type AuthVars, assertEmailVerified, requireAuth, restActor } from '../middleware/auth.js';
import { invalid, noQuery, zValidator } from '../middleware/zod-validator.js';
import { requiresOnParam } from '../permissions/index.js';
import {
  SECRETS_LIST_SAYS,
  secretValueDoor,
  secretValueDoors,
  secretValueElsewhere,
} from './secret-value-door.js';
import { writeSecret } from './secret-write.js';
import { deleteSecret, listSecretNames, listTestingProfiles, SECRET_VALUE_MAX } from './service.js';

export const projectSecretRoutes = new Hono<{ Variables: AuthVars }>();

for (const path of ['/:id/secrets', '/:id/secrets/*', '/:id/test-credentials']) {
  projectSecretRoutes.use(path, requireAuth(), assertEmailVerified());
}

const NAME = /^[a-z][a-z0-9-]{0,62}$/;
const idParam = z.object({ id: z.uuid() });
const secretParam = z.object({
  id: z.uuid(),
  scope: z.string().regex(NAME),
  name: z.string().regex(NAME),
});
const secretBody = z.strictObject({ value: z.string().min(1).max(SECRET_VALUE_MAX) });

const paramOf = <T extends z.ZodType>(schema: T) =>
  zValidator(
    'param',
    schema,
    invalid(
      'invalid path: the project id is a uuid, and a profile id, secret scope or name matches ^[a-z][a-z0-9-]{0,62}$',
    ),
  );

const secretView = (s: { ref: string; scope: string; name: string; updatedAt: Date }) => ({
  ref: s.ref,
  scope: s.scope,
  name: s.name,
  updatedAt: s.updatedAt.toISOString(),
});

const READ = requiresOnParam('project.read', 'id');
const ADMIN = requiresOnParam('project.admin', 'id');

/** The owner's credential for a product is kept at its own door, which checks its shape (ISS-1013). */
const ownerScopeSays = (id: string, done: 'written' | 'removed') =>
  `\`${SUPPORT_OWNER_CREDENTIAL_SCOPE}\` holds the owner's credential a support room acts in a product with, and it is ${done} only at ${done === 'written' ? 'PUT' : 'DELETE'} /api/projects/${id}/support/owner-credentials/<support-api binding id>.`;

const reserved = (detail: string) => [
  { code: 'SECRET_SCOPE_RESERVED' as const, path: '/scope', detail },
];

projectSecretRoutes.get('/:id/secrets', paramOf(idParam), READ, noQuery, async (c) => {
  const { id } = c.req.valid('param');
  const [secrets, profiles] = await Promise.all([listSecretNames(id), listTestingProfiles(id)]);
  return c.json({
    secrets: secrets.map((s) => ({ ...secretView(s), valueAt: secretValueDoors(profiles, s.ref) })),
    returned: secrets.length,
    says: SECRETS_LIST_SAYS,
  });
});

// a value guessed at a secret's own path is refused naming the door each profile reads it at
projectSecretRoutes.get(
  '/:id/secrets/:scope/:name',
  paramOf(secretParam),
  READ,
  noQuery,
  async (c) => {
    const { id, scope, name } = c.req.valid('param');
    const ref = secretRefOf(scope, name);
    const [door] = secretValueDoors(await listTestingProfiles(id), ref);
    throw secretValueElsewhere(
      `GET /api/projects/${id}/secrets/${scope}/${name}`,
      door ?? secretValueDoor('<profile naming it>', `ref=${ref}`),
    );
  },
);

projectSecretRoutes.get('/:id/test-credentials', paramOf(idParam), READ, noQuery, async (c) => {
  const { id } = c.req.valid('param');
  throw secretValueElsewhere(
    `GET /api/projects/${id}/test-credentials`,
    secretValueDoor('<profile>', 'actor=<actor>'),
  );
});

// a testing profile's actor secret is tried at the environment naming that profile before it is
// kept: refused SECRET_DOES_NOT_SIGN_IN where the environment answers no session, stored and
// flagged on the profile where it cannot answer (ISS-937, `secret-write.ts`); `signIn` says which
projectSecretRoutes.put(
  '/:id/secrets/:scope/:name',
  paramOf(secretParam),
  ADMIN,
  zValidator(
    'json',
    secretBody,
    invalid(
      `the body is { "value": string }, 1 to ${SECRET_VALUE_MAX} characters, and nothing else`,
      'SECRET_WRITE_SHAPE',
    ),
  ),
  async (c) => {
    const { id, scope, name } = c.req.valid('param');
    if (scope === VARIABLE_SECRET_SCOPE) {
      return refused(
        c,
        reserved(
          `\`${VARIABLE_SECRET_SCOPE}\` holds the project's variable values and is written only as a variable: POST /api/projects/${id}/variables. Store this secret under another scope.`,
        ),
        'CONFIG_REFUSED',
      );
    }
    if (scope === SUPPORT_OWNER_CREDENTIAL_SCOPE) {
      return refused(c, reserved(ownerScopeSays(id, 'written')), 'CONFIG_REFUSED');
    }
    const actor = restActor(c);
    const outcome = await writeSecret({
      projectId: id,
      scope,
      name,
      value: c.req.valid('json').value,
      actor: { id: actor.id, tokenId: actor.tokenId, agency: actor.agency },
    });
    if (!outcome.ok && 'refusals' in outcome) {
      return refused(c, outcome.refusals, 'CONFIG_REFUSED');
    }
    if (!outcome.ok) {
      throw new HTTPException(503, {
        message:
          'INTEGRATION_MASTER_KEY is not set on this core, so a secret cannot be encrypted; nothing was written.',
        cause: { code: outcome.code },
      });
    }
    return c.json({ ...secretView(outcome.secret), signIn: outcome.signIn });
  },
);

// remove one secret (ISS-847): the PUT's rule, refused by name while a testing profile names it or
// when there is none, and written to the project's credential audit (GET /variables/events)
projectSecretRoutes.delete(
  '/:id/secrets/:scope/:name',
  paramOf(secretParam),
  ADMIN,
  noQuery,
  async (c) => {
    const { id, scope, name } = c.req.valid('param');
    if (scope === VARIABLE_SECRET_SCOPE) {
      return refused(
        c,
        reserved(
          `\`${VARIABLE_SECRET_SCOPE}\` holds the project's variable values and is removed only as a variable: DELETE /api/projects/${id}/variables/<variable id>.`,
        ),
        'CONFIG_REFUSED',
      );
    }
    if (scope === SUPPORT_OWNER_CREDENTIAL_SCOPE) {
      return refused(c, reserved(ownerScopeSays(id, 'removed')), 'CONFIG_REFUSED');
    }
    const actor = restActor(c);
    const outcome = await deleteSecret({
      projectId: id,
      scope,
      name,
      actor: { id: actor.id, tokenId: actor.tokenId, agency: actor.agency },
    });
    if (outcome.ok) return c.json({ deleted: secretRefOf(scope, name) });
    if (outcome.notFound) {
      throw new HTTPException(404, {
        message: `this project holds no secret ${secretRefOf(scope, name)}; GET /api/projects/${id}/secrets lists the ones it holds`,
        cause: { code: 'SECRET_NOT_FOUND' },
      });
    }
    return refused(c, outcome.refusals, 'CONFIG_REFUSED');
  },
);
