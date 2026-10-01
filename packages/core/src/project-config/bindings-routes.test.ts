import { readFileSync } from 'node:fs';
import { Hono, type MiddlewareHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  bindingMem,
  COOLIFY_CONNECTION,
  ORG,
  resetBindingMem,
  SHOPIFY_CONNECTION,
  seedBindingRow,
} from './binding-store.fixture.js';
import { ADMIN, mem, OTHER_PROJECT, PROJECT, VIEWER } from './memory-store.fixture.js';

vi.mock('./store.js', async () => ({
  drizzleConfigStore: (await import('./memory-store.fixture.js')).memoryStore,
}));

vi.mock('./binding-store.js', async () => ({
  drizzleBindingStore: (await import('./binding-store.fixture.js')).memoryBindingStore,
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
    const userId = (c.req.header('authorization') ?? '').replace('Bearer user:', '');
    if (!userId) throw new HTTPException(401, { message: 'invalid token' });
    c.set('userId', userId);
    c.set('principal', 'user');
    await next();
  },
  assertEmailVerified: (): MiddlewareHandler => async (_c, next) => next(),
}));

const { projectConfigRoutes } = await import('./routes.js');

const BINDING = '8b3c4d5e-6f7a-4b2c-9d3e-4f5a6b7c8d9e';
const SOURCE = '7a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d';

function app() {
  const a = new Hono();
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

const call = (method: string, path: string, body?: unknown, who = ADMIN) =>
  app().request(`/api/projects/${PROJECT}${path}`, {
    method,
    headers: { authorization: `Bearer user:${who}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const coolifyDoc = (overrides: Record<string, unknown> = {}) => ({
  $schema: 'https://forge.sidcorp.co/schemas/binding-v1.json',
  version: 1,
  id: BINDING,
  role: 'deploy',
  connection: COOLIFY_CONNECTION,
  target: { provider: 'coolify', applicationUuid: 'y8w4c4kss8ogo8gc44ow44kc' },
  ...overrides,
});

type Refused = {
  error: { code: string; refusals: { code: string; path: string; detail: string }[] };
};
const refusalsOf = async (res: Response) => ((await res.json()) as Refused).error.refusals;

beforeEach(() => {
  mem.project.clear();
  mem.profiles.clear();
  mem.roles.clear();
  mem.roles.set(ADMIN, 'admin');
  mem.roles.set(VIEWER, 'viewer');
  resetBindingMem();
  bindingMem.connections.set(COOLIFY_CONNECTION, {
    id: COOLIFY_CONNECTION,
    provider: 'coolify',
    ownerType: 'org',
    ownerId: ORG,
    active: true,
  });
  bindingMem.connections.set(SHOPIFY_CONNECTION, {
    id: SHOPIFY_CONNECTION,
    provider: 'shopify',
    ownerType: 'user',
    ownerId: ADMIN,
    active: true,
  });
  bindingMem.orgAdmins.add(ADMIN);
});

describe('binding documents', () => {
  it('round-trips a coolify deploy binding onto the row S4 reads', async () => {
    const res = await call('PUT', `/bindings/${BINDING}`, {
      baseRevision: null,
      document: coolifyDoc(),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ declared: true, revision: 1, created: true });
    expect(bindingMem.rows.get(BINDING)).toMatchObject({
      role: 'deploy',
      config: { targets: [{ resourceUuid: 'y8w4c4kss8ogo8gc44ow44kc' }] },
    });
    expect(bindingMem.rows.get(BINDING)).not.toHaveProperty('stages');
    const read = (await (await call('GET', `/bindings/${BINDING}`, undefined, VIEWER)).json()) as {
      document: unknown;
    };
    expect(read.document).toEqual(coolifyDoc());
  });

  it('writes a source binding', async () => {
    const doc = coolifyDoc({
      id: SOURCE,
      role: 'source',
      connection: SHOPIFY_CONNECTION,
      target: { provider: 'shopify', store: 'example-store.myshopify.com' },
    });
    const res = await call('PUT', `/bindings/${SOURCE}`, { baseRevision: null, document: doc });
    expect(res.status).toBe(200);
    expect(bindingMem.rows.get(SOURCE)).toMatchObject({ role: 'source' });
    expect(bindingMem.rows.get(SOURCE)).not.toHaveProperty('stages');
  });

  it('refuses CONNECTION_NOT_FOUND for a connection that does not exist, and writes nothing', async () => {
    const doc = coolifyDoc({ connection: '99999999-9999-4999-8999-999999999999' });
    const res = await call('PUT', `/bindings/${BINDING}`, { baseRevision: null, document: doc });
    expect(res.status).toBe(422);
    expect(await refusalsOf(res)).toEqual([
      expect.objectContaining({ code: 'CONNECTION_NOT_FOUND', path: '/connection' }),
    ]);
    expect(bindingMem.rows.size).toBe(0);
  });

  it("refuses CONNECTION_NOT_FOUND for another organisation's connection", async () => {
    bindingMem.connections.set(COOLIFY_CONNECTION, {
      id: COOLIFY_CONNECTION,
      provider: 'coolify',
      ownerType: 'org',
      ownerId: '88888888-8888-4888-8888-888888888888',
      active: true,
    });
    const res = await call('PUT', `/bindings/${BINDING}`, {
      baseRevision: null,
      document: coolifyDoc(),
    });
    expect((await refusalsOf(res))[0]).toMatchObject({ code: 'CONNECTION_NOT_FOUND' });
  });

  it('refuses CONNECTION_PROVIDER_MISMATCH when the target is not the connection provider', async () => {
    const doc = coolifyDoc({ connection: SHOPIFY_CONNECTION });
    const res = await call('PUT', `/bindings/${BINDING}`, { baseRevision: null, document: doc });
    expect(res.status).toBe(422);
    expect(await refusalsOf(res)).toEqual([
      expect.objectContaining({ code: 'CONNECTION_PROVIDER_MISMATCH', path: '/target/provider' }),
    ]);
    expect(bindingMem.rows.size).toBe(0);
  });

  it('refuses STALE_BASE naming the stored revision', async () => {
    await call('PUT', `/bindings/${BINDING}`, { baseRevision: null, document: coolifyDoc() });
    const res = await call('PUT', `/bindings/${BINDING}`, {
      baseRevision: null,
      document: coolifyDoc(),
    });
    expect(await refusalsOf(res)).toEqual([
      expect.objectContaining({
        code: 'STALE_BASE',
        detail: expect.stringContaining('revision 1'),
      }),
    ]);
  });

  it("refuses an id that is not the URL's, and an id another project holds", async () => {
    const wrong = await call('PUT', `/bindings/${BINDING}`, {
      baseRevision: null,
      document: coolifyDoc({ id: SOURCE }),
    });
    expect((await refusalsOf(wrong))[0]).toMatchObject({ code: 'BINDING_ID_MISMATCH' });
    seedBindingRow({
      id: SOURCE,
      projectId: OTHER_PROJECT,
      connectionId: COOLIFY_CONNECTION,
      provider: 'coolify',
      role: 'deploy',
      config: {},
      active: true,
      revision: 1,
    });
    const foreign = await call('PUT', `/bindings/${SOURCE}`, {
      baseRevision: 1,
      document: coolifyDoc({ id: SOURCE }),
    });
    expect((await refusalsOf(foreign))[0]).toMatchObject({ code: 'BINDING_ID_MISMATCH' });
  });

  it('refuses an epodsystem target by name rather than guessing its row shape', async () => {
    bindingMem.connections.set(COOLIFY_CONNECTION, {
      id: COOLIFY_CONNECTION,
      provider: 'epodsystem',
      ownerType: 'org',
      ownerId: ORG,
      active: true,
    });
    const doc = coolifyDoc({ target: { provider: 'epodsystem', store: 'shop' } });
    const res = await call('PUT', `/bindings/${BINDING}`, { baseRevision: null, document: doc });
    expect(await refusalsOf(res)).toEqual([
      expect.objectContaining({ code: 'BINDING_TARGET_UNSUPPORTED' }),
    ]);
  });

  it('refuses a viewer write', async () => {
    const res = await call(
      'PUT',
      `/bindings/${BINDING}`,
      { baseRevision: null, document: coolifyDoc() },
      VIEWER,
    );
    expect(res.status).toBe(403);
    expect(bindingMem.rows.size).toBe(0);
  });

  it('lists a row with no document form by name instead of dropping it', async () => {
    seedBindingRow({
      id: SOURCE,
      projectId: PROJECT,
      connectionId: COOLIFY_CONNECTION,
      provider: 'coolify',
      role: 'deploy',
      config: { targets: [] },
      active: true,
      revision: 3,
    });
    const body = (await (await call('GET', '/bindings', undefined, VIEWER)).json()) as {
      returned: number;
      unrepresentable: { id: string }[];
    };
    expect(body.returned).toBe(0);
    expect(body.unrepresentable).toEqual([expect.objectContaining({ id: SOURCE })]);
    expect((await call('GET', `/bindings/${SOURCE}`, undefined, VIEWER)).status).toBe(409);
  });

  it('refuses changing the role of a binding the project document names, BINDING_IN_USE', async () => {
    const simBinding = '3f1c2a9e-7b4d-4e21-9c1a-5d6e7f8a9b0c';
    const project = JSON.parse(
      readFileSync(new URL('./fixtures/sim-forge-dev/project.json', import.meta.url), 'utf8'),
    );
    mem.project.set(PROJECT, {
      revision: 1,
      document: project,
      updatedBy: ADMIN,
      updatedAt: new Date(),
    });
    const res = await call('PUT', `/bindings/${simBinding}`, {
      baseRevision: null,
      document: coolifyDoc({ id: simBinding, role: 'service' }),
    });
    expect(await refusalsOf(res)).toEqual([
      expect.objectContaining({
        code: 'BINDING_IN_USE',
        path: '/role',
        detail: expect.stringContaining('/environments/beta/deployment/binding'),
      }),
    ]);
  });
});

describe('a target provider the binding document does not define', () => {
  for (const provider of ['', 'github']) {
    it(`refuses provider ${JSON.stringify(provider)} naming every provider it does define`, async () => {
      const doc = coolifyDoc({ target: { provider } });
      const res = await call('PUT', `/bindings/${BINDING}`, { baseRevision: null, document: doc });
      expect(res.status).toBe(422);
      expect(await refusalsOf(res)).toEqual([
        {
          code: 'SCHEMA_VIOLATION',
          path: '/target/provider',
          detail: `provider ${JSON.stringify(provider)} is not a binding target; target.provider is one of coolify, shopify, epodsystem, each with the fields binding-v1.json names for it.`,
        },
      ]);
      expect(bindingMem.rows.size).toBe(0);
    });
  }

  it('refuses a target with no provider at all, by the same name', async () => {
    const res = await call('PUT', `/bindings/${BINDING}`, {
      baseRevision: null,
      document: coolifyDoc({ target: {} }),
    });
    expect((await refusalsOf(res))[0]?.detail).toMatch(
      /^a target with no provider is not a binding target; target\.provider is one of coolify, shopify, epodsystem,/,
    );
  });
});

describe('a binding holding keys the document has no field for', () => {
  const held = {
    targets: [{ id: 'primary', label: 'primary', resourceUuid: 'abcdefghijklmnopqrstu' }],
    releaseRunnerLabel: 'release',
    rollback: 'redeploy the previous image',
  };

  beforeEach(() => {
    seedBindingRow({
      id: BINDING,
      projectId: PROJECT,
      connectionId: COOLIFY_CONNECTION,
      provider: 'coolify',
      role: 'deploy',
      config: held,
      active: true,
      revision: 2,
    });
  });

  it('is listed as unrepresentable, naming each key it would lose', async () => {
    const body = (await (await call('GET', '/bindings', undefined, VIEWER)).json()) as {
      returned: number;
      unrepresentable: { id: string; reason: string }[];
    };
    expect(body.returned).toBe(0);
    expect(body.unrepresentable).toEqual([
      expect.objectContaining({
        id: BINDING,
        reason: expect.stringContaining('`releaseRunnerLabel`, `rollback`'),
      }),
    ]);
  });

  it('refuses a document write over it, and the row keeps every key', async () => {
    const res = await call('PUT', `/bindings/${BINDING}`, {
      baseRevision: 2,
      document: coolifyDoc(),
    });
    expect(res.status).toBe(422);
    expect(await refusalsOf(res)).toEqual([
      expect.objectContaining({ code: 'BINDING_NOT_REPRESENTABLE', path: '' }),
    ]);
    expect(bindingMem.rows.get(BINDING)?.config).toEqual(held);
  });
});
