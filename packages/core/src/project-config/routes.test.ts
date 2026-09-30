import { Hono, type MiddlewareHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ADMIN,
  DEPLOY_BINDING,
  DEVICE,
  mem,
  OTHER_PROJECT,
  PROJECT,
  SECRET_VALUE,
  VIEWER,
} from './memory-store.fixture.js';

process.env.INTEGRATION_MASTER_KEY = Buffer.alloc(32, 7).toString('base64');

vi.mock('./store.js', async () => ({
  drizzleConfigStore: (await import('./memory-store.fixture.js')).memoryStore,
}));

vi.mock('../lib/authz.js', async () => {
  const fixture = await import('./memory-store.fixture.js');
  return {
    assertProjectAccess: vi.fn(async (_projectId: string, userId: string, min: string) => {
      const role = fixture.mem.roles.get(userId);
      if (!role || (min === 'admin' && role !== 'admin')) {
        throw new HTTPException(403, {
          message: 'not a project member',
          cause: { code: 'FORBIDDEN' },
        });
      }
      return { role };
    }),
  };
});

vi.mock('../middleware/auth.js', () => ({
  requireAuth: (): MiddlewareHandler => async (c, next) => {
    const [kind, userId] = (c.req.header('authorization') ?? '').replace('Bearer ', '').split(':');
    if (!userId) throw new HTTPException(401, { message: 'invalid token' });
    c.set('userId', userId);
    c.set('principal', kind === 'device' ? 'pat' : 'user');
    await next();
  },
  assertEmailVerified: (): MiddlewareHandler => async (_c, next) => next(),
}));

vi.mock('../auth/device-credential.js', () => ({
  verifyDeviceCredential: vi.fn(async (token: string) =>
    token.startsWith('device:') ? { id: DEVICE } : null,
  ),
}));

const { projectConfigRoutes } = await import('./routes.js');
const { projectConfigSchemaRoutes } = await import('./schema-routes.js');
const { decryptSecret } = await import('../integrations/vault.js');

function app() {
  const a = new Hono();
  a.route('/api', projectConfigSchemaRoutes);
  a.route('/api/projects', projectConfigRoutes);
  a.onError((err, c) => {
    if (err instanceof HTTPException) {
      const cause = err.cause as { code?: string } | undefined;
      return c.json({ code: cause?.code ?? 'HTTP', message: err.message }, err.status);
    }
    throw err;
  });
  return a;
}

const as = (who: string, kind: 'user' | 'device' = 'user') => ({
  authorization: `Bearer ${kind}:${who}`,
  'content-type': 'application/json',
});

const get = (path: string, who = ADMIN, kind: 'user' | 'device' = 'user') =>
  app().request(`/api/projects/${PROJECT}${path}`, { headers: as(who, kind) });

const put = (path: string, body: unknown, who = ADMIN) =>
  app().request(`/api/projects/${PROJECT}${path}`, {
    method: 'PUT',
    headers: as(who),
    body: JSON.stringify(body),
  });

function projectDoc(overrides: Record<string, unknown> = {}) {
  return {
    $schema: 'https://forge.sidcorp.co/schemas/project-v1.json',
    version: 1,
    project: { id: PROJECT, slug: 'forge-dev', name: 'Forge Dev' },
    source: {
      type: 'git',
      git: {
        repository: 'github.com/SidCorp-co/forge',
        defaultBranch: 'main',
        branches: ['main', 'dev'],
      },
    },
    workspace: { isolation: 'worktree', setup: 'pnpm install' },
    validation: { gate: { type: 'github-check', name: 'ci-passed' } },
    environments: {
      beta: {
        tier: 'production',
        deploysFrom: 'main',
        deployment: { binding: DEPLOY_BINDING, trigger: 'on-land' },
        url: 'https://forge-beta.sidcorp.co',
        testing: 'beta',
      },
    },
    promotions: [{ from: 'dev', to: 'main', via: 'merge' }],
    rollback: { strategy: 'revert-and-redeploy' },
    execution: {
      plugin: {
        source: 'SidCorp-co/forge-plugin',
        ref: '73225dedb41b5da26b4ce73518086e26e81f91b8',
      },
    },
    ...overrides,
  };
}

const policyDoc = {
  $schema: 'https://forge.sidcorp.co/schemas/policy-v1.json',
  version: 1,
  qa: 'independent',
  intake: { mode: 'auto' },
  permissions: { development: { deny: ['projects.update'] } },
  states: { open: { model: 'opus', permissions: 'development' } },
};

const profileDoc = (credential = 'secret://forge-dev/beta-admin') => ({
  $schema: 'https://forge.sidcorp.co/schemas/testing-profile-v1.json',
  version: 1,
  id: 'beta',
  actors: { admin: { role: 'deployment-admin', credential } },
  services: {},
  limits: [{ id: 'shared-with-the-fleet', note: 'Never mutate outside the issue under test.' }],
});

async function seedProfile() {
  expect((await put('/secrets/forge-dev/beta-admin', { value: SECRET_VALUE })).status).toBe(200);
  const res = await put('/testing-profiles/beta', { baseRevision: null, document: profileDoc() });
  expect(res.status).toBe(200);
}

type Effective = {
  device: string | null;
  undeclared: string[];
  values: Record<string, unknown>;
};

type Refusals = {
  error: { code: string; refusals: { code: string; path: string; detail: string }[] };
};

beforeEach(() => {
  mem.project.clear();
  mem.revisions.clear();
  mem.policy.clear();
  mem.profiles.clear();
  mem.secrets.clear();
  mem.checkouts.length = 0;
  mem.bindings = [
    { id: DEPLOY_BINDING, role: 'deploy', provider: 'coolify', stages: ['live'], label: '' },
  ];
  mem.roles.clear();
  mem.roles.set(ADMIN, 'admin');
  mem.roles.set(VIEWER, 'viewer');
});

describe('project document — read and write', () => {
  it('answers an unset document 200 declared:false, never a 404 or a default', async () => {
    const res = await get('/config');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ declared: false, revision: null, document: null });
  });

  it('round-trips a PUT through GET and records one write-once revision', async () => {
    await seedProfile();
    const written = await put('/config', { baseRevision: null, document: projectDoc() });
    expect(written.status).toBe(200);
    expect(await written.json()).toMatchObject({ declared: true, revision: 1, created: true });

    const read = (await (await get('/config', VIEWER)).json()) as {
      document: unknown;
    };
    expect(read).toMatchObject({ declared: true, revision: 1, updatedBy: ADMIN });
    expect(read.document).toEqual(projectDoc());

    const second = await put('/config', {
      baseRevision: 1,
      document: projectDoc({ rollback: { strategy: 'none' } }),
    });
    expect(second.status).toBe(200);
    const revisions = (await (await get('/config/revisions', VIEWER)).json()) as {
      returned: number;
      revisions: { revision: number; document: unknown }[];
    };
    expect(revisions.returned).toBe(2);
    expect(revisions.revisions.map((r) => r.revision)).toEqual([2, 1]);
    expect(revisions.revisions[1]?.document).toEqual(projectDoc());
  });

  it('refuses STALE_BASE naming the stored revision, and leaves the stored document alone', async () => {
    await seedProfile();
    await put('/config', { baseRevision: null, document: projectDoc() });
    const res = await put('/config', {
      baseRevision: null,
      document: projectDoc({ rollback: { strategy: 'none' } }),
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as Refusals;
    expect(body.error.code).toBe('STALE_BASE');
    expect(body.error.refusals[0]?.detail).toContain('revision 1');
    expect(mem.project.get(PROJECT)?.revision).toBe(1);
    expect(mem.project.get(PROJECT)?.document).toEqual(projectDoc());
  });

  it('refuses PROJECT_ID_IMMUTABLE when project.id is not the URL id', async () => {
    await seedProfile();
    const doc = projectDoc({ project: { id: OTHER_PROJECT, slug: 'forge-dev', name: 'x' } });
    const res = await put('/config', { baseRevision: null, document: doc });
    expect(res.status).toBe(422);
    const body = (await res.json()) as Refusals;
    expect(body.error.refusals).toEqual([
      expect.objectContaining({ code: 'PROJECT_ID_IMMUTABLE', path: '/project/id' }),
    ]);
    expect(mem.project.size).toBe(0);
  });

  it('refuses VERSION_UNSUPPORTED alone rather than reading a v2 document as v1', async () => {
    const res = await put('/config', { baseRevision: null, document: projectDoc({ version: 2 }) });
    const body = (await res.json()) as Refusals;
    expect(res.status).toBe(422);
    expect(body.error.refusals).toEqual([
      expect.objectContaining({ code: 'VERSION_UNSUPPORTED', path: '/version' }),
    ]);
  });

  it('refuses an unknown key by name at its JSON pointer', async () => {
    const doc = projectDoc({ workspace: { isolation: 'worktree', releaseModel: 'dev-base' } });
    const body = (await (
      await put('/config', { baseRevision: null, document: doc })
    ).json()) as Refusals;
    expect(body.error.refusals).toContainEqual(
      expect.objectContaining({ code: 'UNKNOWN_KEY', path: '/workspace/releaseModel' }),
    );
  });

  it('refuses a field of the wrong shape at its pointer', async () => {
    const doc = projectDoc({
      execution: { plugin: { source: 'SidCorp-co/forge-plugin', ref: 'main' } },
    });
    const body = (await (
      await put('/config', { baseRevision: null, document: doc })
    ).json()) as Refusals;
    expect(body.error.refusals).toContainEqual(
      expect.objectContaining({ code: 'SCHEMA_VIOLATION', path: '/execution/plugin/ref' }),
    );
  });

  it('writes nothing when a cross-field rule refuses (binding and profile unknown)', async () => {
    mem.bindings = [];
    const res = await put('/config', { baseRevision: null, document: projectDoc() });
    expect(res.status).toBe(422);
    const codes = ((await res.json()) as Refusals).error.refusals.map((r) => r.code);
    expect(codes).toEqual(
      expect.arrayContaining(['BINDING_NOT_FOUND', 'TESTING_PROFILE_NOT_FOUND']),
    );
    expect(mem.project.size).toBe(0);
    expect(mem.revisions.size).toBe(0);
    expect(await (await get('/config')).json()).toMatchObject({ declared: false });
  });

  it('refuses SLUG_TAKEN when another project holds the slug', async () => {
    await seedProfile();
    const doc = projectDoc({ project: { id: PROJECT, slug: 'taken-slug', name: 'x' } });
    const body = (await (
      await put('/config', { baseRevision: null, document: doc })
    ).json()) as Refusals;
    expect(body.error.refusals).toEqual([expect.objectContaining({ code: 'SLUG_TAKEN' })]);
  });

  it('refuses a body with no baseRevision by name, 400', async () => {
    const res = await put('/config', { document: projectDoc() });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'CONFIG_WRITE_SHAPE' });
  });
});

describe('authorisation', () => {
  it('lets a viewer read and refuses a viewer every write', async () => {
    expect((await get('/config', VIEWER)).status).toBe(200);
    const writes = await Promise.all([
      put('/config', { baseRevision: null, document: projectDoc() }, VIEWER),
      put('/policy', { baseRevision: null, document: policyDoc }, VIEWER),
      put('/testing-profiles/beta', { baseRevision: null, document: profileDoc() }, VIEWER),
      put('/secrets/forge-dev/beta-admin', { value: SECRET_VALUE }, VIEWER),
    ]);
    expect(writes.map((w) => w.status)).toEqual([403, 403, 403, 403]);
    expect(mem.project.size + mem.policy.size + mem.profiles.size + mem.secrets.size).toBe(0);
  });

  it('refuses a caller who is no member at all, even to read', async () => {
    expect((await get('/config', '44444444-4444-4444-8444-444444444444')).status).toBe(403);
  });
});

describe('policy and testing profiles', () => {
  it('refuses PERMISSION_PROFILE_UNDEFINED and writes nothing', async () => {
    const doc = { ...policyDoc, states: { open: { model: 'opus', permissions: 'nobody' } } };
    const res = await put('/policy', { baseRevision: null, document: doc });
    expect(res.status).toBe(422);
    expect(((await res.json()) as Refusals).error.code).toBe('PERMISSION_PROFILE_UNDEFINED');
    expect(mem.policy.size).toBe(0);
  });

  it('refuses SECRET_NOT_FOUND for a credential ref the vault does not hold', async () => {
    const res = await put('/testing-profiles/beta', {
      baseRevision: null,
      document: profileDoc('secret://forge-dev/missing'),
    });
    expect(res.status).toBe(422);
    expect(((await res.json()) as Refusals).error.refusals).toEqual([
      expect.objectContaining({ code: 'SECRET_NOT_FOUND', path: '/actors/admin/credential' }),
    ]);
    expect(mem.profiles.size).toBe(0);
  });

  it('refuses a profile whose id is not the URL id', async () => {
    await put('/secrets/forge-dev/beta-admin', { value: SECRET_VALUE });
    const res = await put('/testing-profiles/dev', { baseRevision: null, document: profileDoc() });
    expect(((await res.json()) as Refusals).error.code).toBe('TESTING_PROFILE_ID_MISMATCH');
  });

  it('refuses deleting a profile an environment names, and deletes one nobody names', async () => {
    await seedProfile();
    await put('/config', { baseRevision: null, document: projectDoc() });
    const inUse = await app().request(`/api/projects/${PROJECT}/testing-profiles/beta`, {
      method: 'DELETE',
      headers: as(ADMIN),
    });
    expect(inUse.status).toBe(422);
    expect(((await inUse.json()) as Refusals).error.refusals).toEqual([
      expect.objectContaining({
        code: 'TESTING_PROFILE_IN_USE',
        path: '/environments/beta/testing',
      }),
    ]);
    const missing = await app().request(`/api/projects/${PROJECT}/testing-profiles/ghost`, {
      method: 'DELETE',
      headers: as(ADMIN),
    });
    expect(missing.status).toBe(404);
  });
});

describe('secrets are write-only', () => {
  it('stores ciphertext and never returns the value from any GET', async () => {
    await seedProfile();
    await put('/policy', { baseRevision: null, document: policyDoc });
    await put('/config', { baseRevision: null, document: projectDoc() });
    mem.checkouts.push({
      projectId: PROJECT,
      deviceId: DEVICE,
      repoPath: '/srv/forge',
      branch: 'dev',
    });

    const stored = mem.secrets.get(`${PROJECT}|forge-dev|beta-admin`);
    expect(stored?.valueEnc.toString('utf8')).not.toContain(SECRET_VALUE);
    expect(decryptSecret(stored?.valueEnc as Buffer)).toBe(SECRET_VALUE);

    const bodies = await Promise.all(
      [
        get('/secrets', VIEWER),
        get('/testing-profiles', VIEWER),
        get('/testing-profiles/beta', VIEWER),
        get('/config', VIEWER),
        get('/config/revisions', VIEWER),
        get('/config/effective', VIEWER),
        get('/config/effective', ADMIN, 'device'),
        get('/policy', VIEWER),
      ].map(async (r) => (await r).text()),
    );
    for (const body of bodies) expect(body).not.toContain(SECRET_VALUE);

    const list = JSON.parse(bodies[0] as string);
    expect(list).toEqual({
      secrets: [
        {
          ref: 'secret://forge-dev/beta-admin',
          scope: 'forge-dev',
          name: 'beta-admin',
          updatedAt: '2026-10-01T00:00:00.000Z',
        },
      ],
      returned: 1,
    });
  });

  it('refuses a secret body carrying anything but value', async () => {
    const res = await put('/secrets/forge-dev/beta-admin', { value: 'x', echo: true });
    expect(res.status).toBe(400);
    expect(mem.secrets.size).toBe(0);
  });
});

describe('effective config', () => {
  it('names the layer every value came from, the device checkout included', async () => {
    await seedProfile();
    await put('/policy', { baseRevision: null, document: policyDoc });
    await put('/config', { baseRevision: null, document: projectDoc() });
    mem.checkouts.push({
      projectId: PROJECT,
      deviceId: DEVICE,
      repoPath: '/srv/forge',
      branch: 'dev',
    });

    const body = (await (await get('/config/effective', ADMIN, 'device')).json()) as Effective;
    expect(body).toMatchObject({ declared: true, revision: 1, device: DEVICE, undeclared: [] });
    expect(body.values['/qa']).toEqual({ value: 'independent', from: 'policy', revision: 1 });
    expect(body.values['/source']).toMatchObject({ from: 'project' });
    expect(body.values['/environments']).toMatchObject({ value: { beta: { tier: 'production' } } });
    expect(body.values['/testing/beta']).toMatchObject({ from: 'testing-profile', revision: 1 });
    expect(body.values[`/bindings/${DEPLOY_BINDING}`]).toMatchObject({
      from: 'binding',
      value: { role: 'deploy', provider: 'coolify' },
    });
    expect(body.values['/checkout']).toEqual({
      from: 'device-binding',
      value: { deviceId: DEVICE, repoPath: '/srv/forge', branch: 'dev' },
    });
  });

  it('says which layers a person caller has not got, rather than inventing them', async () => {
    await put('/config', {
      baseRevision: null,
      document: projectDoc({
        environments: {
          beta: { tier: 'production', deploysFrom: 'main', deployment: { mode: 'external' } },
        },
      }),
    });
    const body = (await (await get('/config/effective', VIEWER)).json()) as Effective;
    expect(body.device).toBeNull();
    expect(body.undeclared).toEqual(['policy', 'testing-profile', 'device-binding']);
    expect(body.values['/checkout']).toBeUndefined();
    expect(body.values['/qa']).toBeUndefined();
  });

  it('answers declared:false when there is no project document', async () => {
    expect(await (await get('/config/effective', VIEWER)).json()).toEqual({
      declared: false,
      revision: null,
    });
  });
});

describe('public schemas', () => {
  it('serves each schema at its $id file name with no credential', async () => {
    const res = await app().request('/api/schemas/project-v1.json');
    expect(res.status).toBe(200);
    expect(((await res.json()) as { $id: string }).$id).toBe(
      'https://forge.sidcorp.co/schemas/project-v1.json',
    );
    for (const file of [
      'policy-v1.json',
      'testing-profile-v1.json',
      'binding-v1.json',
      'environment-state-v1.json',
    ]) {
      expect((await app().request(`/api/schemas/${file}`)).status).toBe(200);
    }
  });

  it('refuses an unknown schema by name, listing what is served', async () => {
    const res = await app().request('/api/schemas/project-v2.json');
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: 'SCHEMA_NOT_FOUND' });
  });
});
