// The acting door's REST face (REQ-88): the one read of a secret the project declares for acting, under
// the box's own credential (`acting-secret-door.ts:readActingSecret`), and the record of those reads
// a project member reads with what is declared.

import { Hono } from 'hono';
import { z } from 'zod';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { invalid, noQuery, zValidator } from '../middleware/zod-validator.js';
import { requiresByRule, requiresOnParam } from '../permissions/index.js';
import { readActingSecret, readActingSecretRecord } from './acting-secret-door.js';
import { jobCredential } from './testing-secrets-routes.js';

export const actingSecretRoutes = new Hono<{ Variables: AuthVars }>();

actingSecretRoutes.use('/:id/acting-secrets', requireAuth(), assertEmailVerified());

const NAME = /^[a-z][a-z0-9-]{0,62}$/;

actingSecretRoutes.get(
  '/:id/acting-secrets',
  zValidator(
    'param',
    z.object({ id: z.uuid() }),
    invalid('invalid path: the project id is a uuid'),
  ),
  requiresOnParam('project.read', 'id'),
  noQuery,
  async (c) => c.json(await readActingSecretRecord(c.req.valid('param').id)),
);

actingSecretRoutes.get(
  '/:id/acting-secrets/:scope/:name',
  zValidator(
    'param',
    z.object({ id: z.uuid(), scope: z.string().regex(NAME), name: z.string().regex(NAME) }),
    invalid(
      'invalid path: the project id is a uuid, and the secret scope and name each match ^[a-z][a-z0-9-]{0,62}$',
      'ACTING_SECRET_READ_SHAPE',
    ),
  ),
  zValidator(
    'query',
    z.strictObject({ run: z.string().min(1).max(100).optional() }),
    invalid(
      'the only query is run=<run id>, naming the declared run that reads; the master names none',
      'ACTING_SECRET_READ_SHAPE',
    ),
  ),
  // the credential and the declaration are the whole gate: the box's master of this project, or a
  // run that box declared over one of its issues, as the project document names its readers
  requiresByRule(
    'project-config/acting-secret-door.ts:readActingSecret',
    "the box's own credential, as the project's live master or a declared run working one of its issues, where the project document names that reader for the secret",
  ),
  async (c) => {
    const { id, scope, name } = c.req.valid('param');
    const principal = await jobCredential(c);
    const read = await readActingSecret({
      principal,
      projectId: id,
      scope,
      name,
      run: c.req.valid('query').run ?? null,
    });
    c.header('Cache-Control', 'no-store');
    return c.json(read);
  },
);
