import { type Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { verifyDeviceCredential } from '../auth/device-credential.js';
import { assertProjectAccess } from '../lib/authz.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { readBearerToken } from '../middleware/bearer.js';
import { zValidator } from '../middleware/zod-validator.js';
import { badRequest } from '../projects/route-errors.js';
import { listBindings, readBinding, writeBinding } from './bindings.js';
import { type ApiRefusal, parseWriteEnvelope } from './documents.js';
import { buildEffectiveConfig } from './effective.js';
import {
  deleteTestingProfile,
  type Held,
  listSecretNames,
  listTestingProfiles,
  putSecret,
  readPolicy,
  readProjectConfig,
  readProjectRevisions,
  readTestingProfile,
  SECRET_VALUE_MAX,
  type WriteOutcome,
  writePolicy,
  writeProjectConfig,
  writeTestingProfile,
} from './service.js';

export const projectConfigRoutes = new Hono<{ Variables: AuthVars }>();

for (const path of [
  '/:id/config',
  '/:id/config/*',
  '/:id/policy',
  '/:id/testing-profiles',
  '/:id/testing-profiles/*',
  '/:id/secrets',
  '/:id/secrets/*',
  '/:id/bindings',
  '/:id/bindings/*',
]) {
  projectConfigRoutes.use(path, requireAuth(), assertEmailVerified());
}

const NAME = /^[a-z][a-z0-9-]{0,62}$/;
const idParam = z.object({ id: z.uuid() });
const profileParam = z.object({ id: z.uuid(), profileId: z.string().regex(NAME) });
const bindingParam = z.object({ id: z.uuid(), bindingId: z.uuid() });
const secretParam = z.object({
  id: z.uuid(),
  scope: z.string().regex(NAME),
  name: z.string().regex(NAME),
});
const secretBody = z.strictObject({ value: z.string().min(1).max(SECRET_VALUE_MAX) });

const paramOf = <T extends z.ZodType>(schema: T) =>
  zValidator('param', schema, (r) => {
    if (!r.success) {
      throw badRequest({
        message:
          'invalid path: the project id is a uuid, and a profile id, secret scope or name matches ^[a-z][a-z0-9-]{0,62}$',
      });
    }
  });

const UNDECLARED = { declared: false as const, revision: null, document: null };

const serialise = <T>(held: Held<T>) => ({
  declared: true as const,
  revision: held.revision,
  document: held.document,
  updatedBy: held.updatedBy,
  updatedAt: held.updatedAt.toISOString(),
});

function refused(c: Context, refusals: ApiRefusal[]) {
  const codes = [...new Set(refusals.map((r) => r.code))];
  const code = codes.length === 1 && codes[0] ? codes[0] : 'CONFIG_REFUSED';
  return c.json(
    {
      error: {
        code,
        message: `refused, nothing written: ${refusals.map((r) => `${r.code} at ${r.path || '/'}`).join('; ')}`,
        refusals,
      },
    },
    422,
  );
}

function envelopeOf(raw: unknown) {
  const envelope = parseWriteEnvelope(raw);
  if (!envelope.ok) {
    throw new HTTPException(400, {
      message: envelope.message,
      cause: { code: 'CONFIG_WRITE_SHAPE' },
    });
  }
  return envelope.value;
}

function answer<T>(c: Context, outcome: WriteOutcome<T>) {
  if (!outcome.ok) return refused(c, outcome.refusals);
  return c.json({ ...serialise(outcome.held), created: outcome.created });
}

projectConfigRoutes.get('/:id/config', paramOf(idParam), async (c) => {
  const { id } = c.req.valid('param');
  await assertProjectAccess(id, c.get('userId'), 'viewer');
  const held = await readProjectConfig(id);
  return c.json(held ? serialise(held) : UNDECLARED);
});

projectConfigRoutes.put(
  '/:id/config',
  paramOf(idParam),
  zValidator('json', z.unknown()),
  async (c) => {
    const { id } = c.req.valid('param');
    const userId = c.get('userId');
    await assertProjectAccess(id, userId, 'admin');
    const { baseRevision, document } = envelopeOf(c.req.valid('json'));
    return answer(
      c,
      await writeProjectConfig({ projectId: id, userId, baseRevision, raw: document }),
    );
  },
);

projectConfigRoutes.get('/:id/config/revisions', paramOf(idParam), async (c) => {
  const { id } = c.req.valid('param');
  await assertProjectAccess(id, c.get('userId'), 'viewer');
  const revisions = await readProjectRevisions(id);
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

async function callingDevice(c: Context<{ Variables: AuthVars }>): Promise<string | null> {
  if (c.get('principal') !== 'pat') return null;
  const device = await verifyDeviceCredential(readBearerToken(c));
  return device?.id ?? null;
}

projectConfigRoutes.get('/:id/config/effective', paramOf(idParam), async (c) => {
  const { id } = c.req.valid('param');
  await assertProjectAccess(id, c.get('userId'), 'viewer');
  return c.json(await buildEffectiveConfig({ projectId: id, deviceId: await callingDevice(c) }));
});

projectConfigRoutes.get('/:id/policy', paramOf(idParam), async (c) => {
  const { id } = c.req.valid('param');
  await assertProjectAccess(id, c.get('userId'), 'viewer');
  const held = await readPolicy(id);
  return c.json(held ? serialise(held) : UNDECLARED);
});

projectConfigRoutes.put(
  '/:id/policy',
  paramOf(idParam),
  zValidator('json', z.unknown()),
  async (c) => {
    const { id } = c.req.valid('param');
    const userId = c.get('userId');
    await assertProjectAccess(id, userId, 'admin');
    const { baseRevision, document } = envelopeOf(c.req.valid('json'));
    return answer(c, await writePolicy({ projectId: id, userId, baseRevision, raw: document }));
  },
);

projectConfigRoutes.get('/:id/testing-profiles', paramOf(idParam), async (c) => {
  const { id } = c.req.valid('param');
  await assertProjectAccess(id, c.get('userId'), 'viewer');
  const profiles = await listTestingProfiles(id);
  return c.json({
    profiles: profiles.map((p) => ({ profileId: p.profileId, ...serialise(p) })),
    returned: profiles.length,
  });
});

projectConfigRoutes.get('/:id/testing-profiles/:profileId', paramOf(profileParam), async (c) => {
  const { id, profileId } = c.req.valid('param');
  await assertProjectAccess(id, c.get('userId'), 'viewer');
  const held = await readTestingProfile(id, profileId);
  return c.json(held ? serialise(held) : UNDECLARED);
});

projectConfigRoutes.put(
  '/:id/testing-profiles/:profileId',
  paramOf(profileParam),
  zValidator('json', z.unknown()),
  async (c) => {
    const { id, profileId } = c.req.valid('param');
    const userId = c.get('userId');
    await assertProjectAccess(id, userId, 'admin');
    const { baseRevision, document } = envelopeOf(c.req.valid('json'));
    return answer(
      c,
      await writeTestingProfile({ projectId: id, profileId, userId, baseRevision, raw: document }),
    );
  },
);

projectConfigRoutes.delete('/:id/testing-profiles/:profileId', paramOf(profileParam), async (c) => {
  const { id, profileId } = c.req.valid('param');
  await assertProjectAccess(id, c.get('userId'), 'admin');
  const outcome = await deleteTestingProfile(id, profileId);
  if (outcome.ok) return c.json({ deleted: true, profileId });
  if (outcome.notFound) {
    throw new HTTPException(404, {
      message: `testing profile "${profileId}" is not declared on this project`,
      cause: { code: 'TESTING_PROFILE_NOT_FOUND' },
    });
  }
  return refused(c, outcome.refusals);
});

projectConfigRoutes.get('/:id/secrets', paramOf(idParam), async (c) => {
  const { id } = c.req.valid('param');
  await assertProjectAccess(id, c.get('userId'), 'viewer');
  const secrets = await listSecretNames(id);
  return c.json({
    secrets: secrets.map((s) => ({
      ref: s.ref,
      scope: s.scope,
      name: s.name,
      updatedAt: s.updatedAt.toISOString(),
    })),
    returned: secrets.length,
  });
});

projectConfigRoutes.put(
  '/:id/secrets/:scope/:name',
  paramOf(secretParam),
  zValidator('json', secretBody, (r) => {
    if (!r.success) {
      throw new HTTPException(400, {
        message: `the body is { "value": string }, 1 to ${SECRET_VALUE_MAX} characters, and nothing else`,
        cause: { code: 'SECRET_WRITE_SHAPE' },
      });
    }
  }),
  async (c) => {
    const { id, scope, name } = c.req.valid('param');
    await assertProjectAccess(id, c.get('userId'), 'admin');
    const outcome = await putSecret({
      projectId: id,
      scope,
      name,
      value: c.req.valid('json').value,
    });
    if (!outcome.ok) {
      throw new HTTPException(503, {
        message:
          'INTEGRATION_MASTER_KEY is not set on this core, so a secret cannot be encrypted; nothing was written.',
        cause: { code: outcome.code },
      });
    }
    return c.json({
      ref: outcome.secret.ref,
      scope: outcome.secret.scope,
      name: outcome.secret.name,
      updatedAt: outcome.secret.updatedAt.toISOString(),
    });
  },
);

projectConfigRoutes.get('/:id/bindings', paramOf(idParam), async (c) => {
  const { id } = c.req.valid('param');
  await assertProjectAccess(id, c.get('userId'), 'viewer');
  const { held, unrepresentable } = await listBindings(id);
  return c.json({
    bindings: held.map((h) => ({ declared: true as const, ...h })),
    unrepresentable,
    returned: held.length,
  });
});

projectConfigRoutes.get('/:id/bindings/:bindingId', paramOf(bindingParam), async (c) => {
  const { id, bindingId } = c.req.valid('param');
  await assertProjectAccess(id, c.get('userId'), 'viewer');
  const read = await readBinding(id, bindingId);
  if (!read) return c.json(UNDECLARED);
  if (!read.ok) {
    throw new HTTPException(409, {
      message: `binding ${bindingId} has no binding-document form: ${read.unrepresentable}`,
      cause: { code: 'BINDING_NOT_REPRESENTABLE' },
    });
  }
  return c.json({ declared: true as const, ...read.held });
});

projectConfigRoutes.put(
  '/:id/bindings/:bindingId',
  paramOf(bindingParam),
  zValidator('json', z.unknown()),
  async (c) => {
    const { id, bindingId } = c.req.valid('param');
    const userId = c.get('userId');
    await assertProjectAccess(id, userId, 'admin');
    const { baseRevision, document } = envelopeOf(c.req.valid('json'));
    const outcome = await writeBinding({
      projectId: id,
      bindingId,
      userId,
      baseRevision,
      raw: document,
    });
    if (!outcome.ok) return refused(c, outcome.refusals);
    return c.json({ declared: true as const, ...outcome.held, created: outcome.created });
  },
);
