import { GATE_MODES, GATE_PROFILES } from '@forge/contracts/gate-profiles';
import { type Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { verifyDeviceCredential } from '../credentials/device-credential.js';
import { refused } from '../lib/refusal.js';
import { envelopeOf } from '../lib/write-envelope.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { parseBearerHeader } from '../middleware/bearer.js';
import { invalid, noQuery, zValidator } from '../middleware/zod-validator.js';
import { requiresOnParam } from '../permissions/index.js';
import { listBindings, readBinding, removeBinding, writeBinding } from './bindings.js';
import { buildEffectiveConfig } from './effective.js';
import { readGateChanges, readProjectGates, writeGates } from './gates.js';
import { profileValueDoor, secretValueDoor, secretValueElsewhere } from './secret-value-door.js';
import { signInStandings } from './secret-write.js';
import {
  deleteTestingProfile,
  type Held,
  listTestingProfiles,
  readPolicy,
  readProjectConfig,
  readTestingProfile,
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

function answer<T>(c: Context, outcome: WriteOutcome<T>) {
  if (!outcome.ok) return refused(c, outcome.refusals, 'CONFIG_REFUSED');
  return c.json({ ...serialise(outcome.held), created: outcome.created });
}

const READ = requiresOnParam('project.read', 'id');
const ADMIN = requiresOnParam('project.admin', 'id');

projectConfigRoutes.get('/:id/config', paramOf(idParam), READ, noQuery, async (c) => {
  const { id } = c.req.valid('param');
  const held = await readProjectConfig(id);
  return c.json(held ? serialise(held) : UNDECLARED);
});

projectConfigRoutes.put(
  '/:id/config',
  paramOf(idParam),
  ADMIN,
  zValidator('json', z.unknown()),
  async (c) => {
    const { id } = c.req.valid('param');
    const userId = c.get('userId');
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

projectConfigRoutes.get('/:id/gates', paramOf(idParam), READ, noQuery, async (c) => {
  const { id } = c.req.valid('param');
  const [gates, changes] = await Promise.all([readProjectGates(id), readGateChanges(id, 20)]);
  return c.json({ ...gates, changes });
});

projectConfigRoutes.put(
  '/:id/gates',
  paramOf(idParam),
  ADMIN,
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
    const body = c.req.valid('json');
    const outcome = await writeGates({ projectId: id, userId, ...body });
    if (!outcome.ok) return refused(c, outcome.refusals, 'GATES_REFUSED');
    return c.json({ ...(await readProjectGates(id)), changes: await readGateChanges(id, 20) });
  },
);

projectConfigRoutes.get('/:id/gates/changes', paramOf(idParam), READ, noQuery, async (c) => {
  const { id } = c.req.valid('param');
  const changes = await readGateChanges(id, 200);
  return c.json({ changes, returned: changes.length });
});

async function callingDevice(c: Context<{ Variables: AuthVars }>): Promise<string | null> {
  const presented = parseBearerHeader(c);
  if (c.get('principal') !== 'pat' || presented.kind !== 'token') return null;
  const device = await verifyDeviceCredential(presented.token);
  return device?.id ?? null;
}

projectConfigRoutes.get('/:id/config/effective', paramOf(idParam), READ, noQuery, async (c) => {
  const { id } = c.req.valid('param');
  return c.json(await buildEffectiveConfig({ projectId: id, deviceId: await callingDevice(c) }));
});

projectConfigRoutes.get('/:id/policy', paramOf(idParam), READ, noQuery, async (c) => {
  const { id } = c.req.valid('param');
  const held = await readPolicy(id);
  return c.json(held ? serialise(held) : UNDECLARED);
});

projectConfigRoutes.put(
  '/:id/policy',
  paramOf(idParam),
  ADMIN,
  zValidator('json', z.unknown()),
  async (c) => {
    const { id } = c.req.valid('param');
    const userId = c.get('userId');
    const { baseRevision, document } = envelopeOf(c.req.valid('json'));
    return answer(c, await writePolicy({ projectId: id, userId, baseRevision, raw: document }));
  },
);

projectConfigRoutes.get('/:id/testing-profiles', paramOf(idParam), READ, noQuery, async (c) => {
  const { id } = c.req.valid('param');
  const profiles = await listTestingProfiles(id);
  const standings = await signInStandings(id, profiles);
  return c.json({
    profiles: profiles.map((p) => ({
      profileId: p.profileId,
      ...serialise(p),
      valueDoor: profileValueDoor(p.profileId, p.document),
      signIn: standings.get(p.profileId),
    })),
    returned: profiles.length,
  });
});

projectConfigRoutes.get(
  '/:id/testing-profiles/:profileId',
  paramOf(profileParam),
  READ,
  noQuery,
  async (c) => {
    const { id, profileId } = c.req.valid('param');
    const held = await readTestingProfile(id, profileId);
    if (!held) return c.json(UNDECLARED);
    // whether each actor's stored secret signed in when it was written (ISS-937, `secret-write.ts`)
    const standings = await signInStandings(id, [{ profileId, document: held.document }]);
    return c.json({
      ...serialise(held),
      valueDoor: profileValueDoor(profileId, held.document),
      signIn: standings.get(profileId),
    });
  },
);

// a value guessed under a profile (`/secrets`, `/credentials`, `/resolve`) is refused naming the door
projectConfigRoutes.get(
  '/:id/testing-profiles/:profileId/:part',
  paramOf(profileParam.extend({ part: z.string().regex(NAME) })),
  READ,
  noQuery,
  async (c) => {
    const { id, profileId, part } = c.req.valid('param');
    const held = await readTestingProfile(id, profileId);
    const door = held
      ? profileValueDoor(profileId, held.document).route
      : secretValueDoor(profileId, 'actor=<actor>');
    throw secretValueElsewhere(
      `GET /api/projects/${id}/testing-profiles/${profileId}/${part}`,
      door,
    );
  },
);

projectConfigRoutes.put(
  '/:id/testing-profiles/:profileId',
  paramOf(profileParam),
  ADMIN,
  zValidator('json', z.unknown()),
  async (c) => {
    const { id, profileId } = c.req.valid('param');
    const userId = c.get('userId');
    const { baseRevision, document } = envelopeOf(c.req.valid('json'));
    return answer(
      c,
      await writeTestingProfile({ projectId: id, profileId, userId, baseRevision, raw: document }),
    );
  },
);

projectConfigRoutes.delete(
  '/:id/testing-profiles/:profileId',
  paramOf(profileParam),
  ADMIN,
  async (c) => {
    const { id, profileId } = c.req.valid('param');
    const outcome = await deleteTestingProfile(id, profileId);
    if (outcome.ok) return c.json({ deleted: true, profileId });
    if (outcome.notFound) {
      throw new HTTPException(404, {
        message: `testing profile "${profileId}" is not declared on this project`,
        cause: { code: 'TESTING_PROFILE_NOT_FOUND' },
      });
    }
    return refused(c, outcome.refusals, 'CONFIG_REFUSED');
  },
);

projectConfigRoutes.get('/:id/bindings', paramOf(idParam), READ, noQuery, async (c) => {
  const { id } = c.req.valid('param');
  const { held, unrepresentable } = await listBindings(id);
  return c.json({
    bindings: held.map((h) => ({ declared: true as const, ...h })),
    unrepresentable,
    returned: held.length,
  });
});

projectConfigRoutes.get(
  '/:id/bindings/:bindingId',
  paramOf(bindingParam),
  READ,
  noQuery,
  async (c) => {
    const { id, bindingId } = c.req.valid('param');
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
  },
);

projectConfigRoutes.put(
  '/:id/bindings/:bindingId',
  paramOf(bindingParam),
  ADMIN,
  zValidator('json', z.unknown()),
  async (c) => {
    const { id, bindingId } = c.req.valid('param');
    const userId = c.get('userId');
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
  ADMIN,
  zValidator('json', z.unknown()),
  async (c) => {
    const { id, bindingId } = c.req.valid('param');
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
export { reviewRunRoutes } from './review-run-routes.js';
export { projectConfigSchemaRoutes } from './schema-routes.js';
export { projectSecretRoutes } from './secret-routes.js';
export { jobTestingSecretsRoutes } from './testing-secrets-routes.js';
export { jobVariableRoutes, variableRoutes } from './variables-routes.js';
