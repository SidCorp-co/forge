import { type Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { verifyDeviceCredential } from '../credentials/device-credential.js';
import { refused } from '../lib/refusal.js';
import { envelopeOf } from '../lib/write-envelope.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { readBearerToken } from '../middleware/bearer.js';
import { badRequest } from '../middleware/route-errors.js';
import { zValidator } from '../middleware/zod-validator.js';
import { actorFor, projectResource, requireCan } from '../permissions/index.js';
import { listBindings, readBinding, removeBinding, writeBinding } from './bindings.js';
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

const secretView = (s: { ref: string; scope: string; name: string; updatedAt: Date }) => ({
  ref: s.ref,
  scope: s.scope,
  name: s.name,
  updatedAt: s.updatedAt.toISOString(),
});

function answer<T>(c: Context, outcome: WriteOutcome<T>) {
  if (!outcome.ok) return refused(c, outcome.refusals, 'CONFIG_REFUSED');
  return c.json({ ...serialise(outcome.held), created: outcome.created });
}

projectConfigRoutes.get('/:id/config', paramOf(idParam), async (c) => {
  const { id } = c.req.valid('param');
  await requireCan(actorFor(c.get('userId')), 'project.read', projectResource(id));
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
    await requireCan(actorFor(userId), 'project.admin', projectResource(id));
    const { baseRevision, document } = envelopeOf(c.req.valid('json'));
    return answer(
      c,
      await writeProjectConfig({ projectId: id, userId, baseRevision, raw: document }),
    );
  },
);

projectConfigRoutes.get('/:id/config/revisions', paramOf(idParam), async (c) => {
  const { id } = c.req.valid('param');
  await requireCan(actorFor(c.get('userId')), 'project.read', projectResource(id));
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
  await requireCan(actorFor(c.get('userId')), 'project.read', projectResource(id));
  return c.json(await buildEffectiveConfig({ projectId: id, deviceId: await callingDevice(c) }));
});

projectConfigRoutes.get('/:id/policy', paramOf(idParam), async (c) => {
  const { id } = c.req.valid('param');
  await requireCan(actorFor(c.get('userId')), 'project.read', projectResource(id));
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
    await requireCan(actorFor(userId), 'project.admin', projectResource(id));
    const { baseRevision, document } = envelopeOf(c.req.valid('json'));
    return answer(c, await writePolicy({ projectId: id, userId, baseRevision, raw: document }));
  },
);

projectConfigRoutes.get('/:id/testing-profiles', paramOf(idParam), async (c) => {
  const { id } = c.req.valid('param');
  await requireCan(actorFor(c.get('userId')), 'project.read', projectResource(id));
  const profiles = await listTestingProfiles(id);
  return c.json({
    profiles: profiles.map((p) => ({ profileId: p.profileId, ...serialise(p) })),
    returned: profiles.length,
  });
});

projectConfigRoutes.get('/:id/testing-profiles/:profileId', paramOf(profileParam), async (c) => {
  const { id, profileId } = c.req.valid('param');
  await requireCan(actorFor(c.get('userId')), 'project.read', projectResource(id));
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
    await requireCan(actorFor(userId), 'project.admin', projectResource(id));
    const { baseRevision, document } = envelopeOf(c.req.valid('json'));
    return answer(
      c,
      await writeTestingProfile({ projectId: id, profileId, userId, baseRevision, raw: document }),
    );
  },
);

projectConfigRoutes.delete('/:id/testing-profiles/:profileId', paramOf(profileParam), async (c) => {
  const { id, profileId } = c.req.valid('param');
  await requireCan(actorFor(c.get('userId')), 'project.admin', projectResource(id));
  const outcome = await deleteTestingProfile(id, profileId);
  if (outcome.ok) return c.json({ deleted: true, profileId });
  if (outcome.notFound) {
    throw new HTTPException(404, {
      message: `testing profile "${profileId}" is not declared on this project`,
      cause: { code: 'TESTING_PROFILE_NOT_FOUND' },
    });
  }
  return refused(c, outcome.refusals, 'CONFIG_REFUSED');
});

projectConfigRoutes.get('/:id/secrets', paramOf(idParam), async (c) => {
  const { id } = c.req.valid('param');
  await requireCan(actorFor(c.get('userId')), 'project.read', projectResource(id));
  const secrets = await listSecretNames(id);
  return c.json({
    secrets: secrets.map(secretView),
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
    await requireCan(actorFor(c.get('userId')), 'project.admin', projectResource(id));
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
    return c.json(secretView(outcome.secret));
  },
);

projectConfigRoutes.get('/:id/bindings', paramOf(idParam), async (c) => {
  const { id } = c.req.valid('param');
  await requireCan(actorFor(c.get('userId')), 'project.read', projectResource(id));
  const { held, unrepresentable } = await listBindings(id);
  return c.json({
    bindings: held.map((h) => ({ declared: true as const, ...h })),
    unrepresentable,
    returned: held.length,
  });
});

projectConfigRoutes.get('/:id/bindings/:bindingId', paramOf(bindingParam), async (c) => {
  const { id, bindingId } = c.req.valid('param');
  await requireCan(actorFor(c.get('userId')), 'project.read', projectResource(id));
  const read = await readBinding(id, bindingId);
  if (!read) return c.json(UNDECLARED);
  if (!read.ok) {
    return refused(
      c,
      [
        {
          code: 'BINDING_NOT_REPRESENTABLE',
          path: '',
          detail: `binding ${bindingId} has no binding-document form: ${read.unrepresentable}`,
        },
      ],
      'CONFIG_REFUSED',
    );
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
    await requireCan(actorFor(userId), 'project.admin', projectResource(id));
    const { baseRevision, document } = envelopeOf(c.req.valid('json'));
    const outcome = await writeBinding({
      projectId: id,
      bindingId,
      userId,
      baseRevision,
      raw: document,
    });
    if (!outcome.ok) return refused(c, outcome.refusals, 'CONFIG_REFUSED');
    return c.json({
      declared: true as const,
      ...outcome.held,
      created: outcome.created,
      effects: outcome.effects,
    });
  },
);

const removeBody = z.strictObject({ baseRevision: z.number().int().positive() });

projectConfigRoutes.delete(
  '/:id/bindings/:bindingId',
  paramOf(bindingParam),
  zValidator('json', z.unknown()),
  async (c) => {
    const { id, bindingId } = c.req.valid('param');
    await requireCan(actorFor(c.get('userId')), 'project.admin', projectResource(id));
    const body = removeBody.safeParse(c.req.valid('json'));
    if (!body.success) {
      throw new HTTPException(400, {
        message:
          'a binding is switched off with { "baseRevision": <the revision it was read at> }, and nothing else',
        cause: { code: 'CONFIG_WRITE_SHAPE' },
      });
    }
    const outcome = await removeBinding({
      projectId: id,
      bindingId,
      baseRevision: body.data.baseRevision,
    });
    if (outcome.ok)
      return c.json({ removed: true as const, bindingId, revision: outcome.revision });
    if ('notFound' in outcome) {
      throw new HTTPException(404, {
        message: `binding ${bindingId} is not a binding of this project`,
        cause: { code: 'NOT_FOUND' },
      });
    }
    return refused(c, outcome.refusals, 'CONFIG_REFUSED');
  },
);

export { environmentStateRoutes } from './environment-state-routes.js';
export { projectConfigSchemaRoutes } from './schema-routes.js';
