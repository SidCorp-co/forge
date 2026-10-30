import { GATE_MODES, GATE_PROFILES } from '@forge/contracts/gate-profiles';
import { secretRefOf } from '@forge/contracts/project-config';
import { type Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { verifyDeviceCredential } from '../credentials/device-credential.js';
import { refused } from '../lib/refusal.js';
import { envelopeOf } from '../lib/write-envelope.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { parseBearerHeader } from '../middleware/bearer.js';
import { invalid, noQuery, zValidator } from '../middleware/zod-validator.js';
import { actorFor, projectResource, requireCan } from '../permissions/index.js';
import { listBindings, readBinding, removeBinding, writeBinding } from './bindings.js';
import { buildEffectiveConfig } from './effective.js';
import { readGateChanges, readProjectGates, writeGates } from './gates.js';
import {
  profileValueDoor,
  SECRETS_LIST_SAYS,
  secretValueDoor,
  secretValueDoors,
  secretValueElsewhere,
} from './secret-value-door.js';
import {
  deleteTestingProfile,
  type Held,
  listSecretNames,
  listTestingProfiles,
  putSecret,
  readPolicy,
  readProjectConfig,
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
  '/:id/test-credentials',
  '/:id/bindings',
  '/:id/bindings/*',
  '/:id/gates',
  '/:id/gates/*',
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
  zValidator(
    'param',
    schema,
    invalid(
      'invalid path: the project id is a uuid, and a profile id, secret scope or name matches ^[a-z][a-z0-9-]{0,62}$',
    ),
  );

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

projectConfigRoutes.get('/:id/config', paramOf(idParam), noQuery, async (c) => {
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

const gatesBody = z.strictObject({
  baseRevision: z.number().int().min(1),
  profile: z.enum(GATE_PROFILES),
  overrides: z.record(z.string(), z.enum(GATE_MODES)).default({}),
  reason: z.string(),
});

projectConfigRoutes.get('/:id/gates', paramOf(idParam), noQuery, async (c) => {
  const { id } = c.req.valid('param');
  await requireCan(actorFor(c.get('userId')), 'project.read', projectResource(id));
  const [gates, changes] = await Promise.all([readProjectGates(id), readGateChanges(id, 20)]);
  return c.json({ ...gates, changes });
});

projectConfigRoutes.put(
  '/:id/gates',
  paramOf(idParam),
  zValidator(
    'json',
    gatesBody,
    invalid(
      'invalid gates write: { baseRevision: the project document revision you read, profile: strict | standard | yolo, overrides: { <gate>: enforce | advise | off }, reason: why }',
    ),
  ),
  async (c) => {
    const { id } = c.req.valid('param');
    const userId = c.get('userId');
    await requireCan(actorFor(userId), 'project.admin', projectResource(id));
    const body = c.req.valid('json');
    const outcome = await writeGates({ projectId: id, userId, ...body });
    if (!outcome.ok) return refused(c, outcome.refusals, 'GATES_REFUSED');
    return c.json({ ...(await readProjectGates(id)), changes: await readGateChanges(id, 20) });
  },
);

projectConfigRoutes.get('/:id/gates/changes', paramOf(idParam), noQuery, async (c) => {
  const { id } = c.req.valid('param');
  await requireCan(actorFor(c.get('userId')), 'project.read', projectResource(id));
  const changes = await readGateChanges(id, 200);
  return c.json({ changes, returned: changes.length });
});

async function callingDevice(c: Context<{ Variables: AuthVars }>): Promise<string | null> {
  const presented = parseBearerHeader(c);
  if (c.get('principal') !== 'pat' || presented.kind !== 'token') return null;
  const device = await verifyDeviceCredential(presented.token);
  return device?.id ?? null;
}

projectConfigRoutes.get('/:id/config/effective', paramOf(idParam), noQuery, async (c) => {
  const { id } = c.req.valid('param');
  await requireCan(actorFor(c.get('userId')), 'project.read', projectResource(id));
  return c.json(await buildEffectiveConfig({ projectId: id, deviceId: await callingDevice(c) }));
});

projectConfigRoutes.get('/:id/policy', paramOf(idParam), noQuery, async (c) => {
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

projectConfigRoutes.get('/:id/testing-profiles', paramOf(idParam), noQuery, async (c) => {
  const { id } = c.req.valid('param');
  await requireCan(actorFor(c.get('userId')), 'project.read', projectResource(id));
  const profiles = await listTestingProfiles(id);
  return c.json({
    profiles: profiles.map((p) => ({
      profileId: p.profileId,
      ...serialise(p),
      valueDoor: profileValueDoor(p.profileId, p.document),
    })),
    returned: profiles.length,
  });
});

projectConfigRoutes.get(
  '/:id/testing-profiles/:profileId',
  paramOf(profileParam),
  noQuery,
  async (c) => {
    const { id, profileId } = c.req.valid('param');
    await requireCan(actorFor(c.get('userId')), 'project.read', projectResource(id));
    const held = await readTestingProfile(id, profileId);
    return c.json(
      held
        ? { ...serialise(held), valueDoor: profileValueDoor(profileId, held.document) }
        : UNDECLARED,
    );
  },
);

// a value guessed under a profile (`/secrets`, `/credentials`, `/resolve`) is refused naming the door
projectConfigRoutes.get(
  '/:id/testing-profiles/:profileId/:part',
  paramOf(profileParam.extend({ part: z.string().regex(NAME) })),
  noQuery,
  async (c) => {
    const { id, profileId, part } = c.req.valid('param');
    await requireCan(actorFor(c.get('userId')), 'project.read', projectResource(id));
    const held = await readTestingProfile(id, profileId);
    const door = held
      ? profileValueDoor(profileId, held.document).route
      : secretValueDoor(profileId, []);
    throw secretValueElsewhere(
      `GET /api/projects/${id}/testing-profiles/${profileId}/${part}`,
      door,
    );
  },
);

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

projectConfigRoutes.get('/:id/secrets', paramOf(idParam), noQuery, async (c) => {
  const { id } = c.req.valid('param');
  await requireCan(actorFor(c.get('userId')), 'project.read', projectResource(id));
  const [secrets, profiles] = await Promise.all([listSecretNames(id), listTestingProfiles(id)]);
  return c.json({
    secrets: secrets.map((s) => ({ ...secretView(s), valueAt: secretValueDoors(profiles, s.ref) })),
    returned: secrets.length,
    says: SECRETS_LIST_SAYS,
  });
});

// a value guessed at a secret's own path is refused naming the door each profile reads it at
projectConfigRoutes.get('/:id/secrets/:scope/:name', paramOf(secretParam), noQuery, async (c) => {
  const { id, scope, name } = c.req.valid('param');
  await requireCan(actorFor(c.get('userId')), 'project.read', projectResource(id));
  const ref = secretRefOf(scope, name);
  const [door] = secretValueDoors(await listTestingProfiles(id), ref);
  throw secretValueElsewhere(
    `GET /api/projects/${id}/secrets/${scope}/${name}`,
    door ?? secretValueDoor('<profile naming it>', [ref]),
  );
});

projectConfigRoutes.get('/:id/test-credentials', paramOf(idParam), noQuery, async (c) => {
  const { id } = c.req.valid('param');
  await requireCan(actorFor(c.get('userId')), 'project.read', projectResource(id));
  throw secretValueElsewhere(
    `GET /api/projects/${id}/test-credentials`,
    secretValueDoor('<profile>', ['<ref>']),
  );
});

projectConfigRoutes.put(
  '/:id/secrets/:scope/:name',
  paramOf(secretParam),
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

projectConfigRoutes.get('/:id/bindings', paramOf(idParam), noQuery, async (c) => {
  const { id } = c.req.valid('param');
  await requireCan(actorFor(c.get('userId')), 'project.read', projectResource(id));
  const { held, unrepresentable } = await listBindings(id);
  return c.json({
    bindings: held.map((h) => ({ declared: true as const, ...h })),
    unrepresentable,
    returned: held.length,
  });
});

projectConfigRoutes.get('/:id/bindings/:bindingId', paramOf(bindingParam), noQuery, async (c) => {
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

export { contentLanguageRoutes } from './content-language-routes.js';
export { environmentStateRoutes } from './environment-state-routes.js';
export { projectConfigSchemaRoutes } from './schema-routes.js';
export { jobTestingSecretsRoutes } from './testing-secrets-routes.js';
