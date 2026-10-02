import { readFileSync } from 'node:fs';
import type { MiddlewareHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  bindingMem,
  COOLIFY_CONNECTION,
  ORG,
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

const effects = vi.hoisted(() => ({
  refusals: vi.fn(async () => [] as { code: string; path: string; detail: string }[]),
  inboundSecret: vi.fn(async () => 'whsec_minted'),
  targetRefusals: vi.fn(async () => [] as { code: string; path: string; detail: string }[]),
  afterWrite: vi.fn(async () => ({}) as Record<string, unknown>),
}));
vi.mock('./bind-effects.js', () => ({ bindEffects: effects }));

const { BINDING, SOURCE, call, coolifyDoc, refusalsOf, resetBindingWorld } = await import(
  './bindings-routes.fixture.js'
);

beforeEach(() => {
  effects.refusals.mockClear();
  effects.inboundSecret.mockClear();
  effects.targetRefusals.mockClear();
  effects.afterWrite.mockClear();
  resetBindingWorld();
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
    expect(read.document).toEqual({ ...coolifyDoc(), agentAccess: 'none', active: true });
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
      label: '',
      agentAccess: 'none',
      active: true,
      revision: 1,
    });
    const foreign = await call('PUT', `/bindings/${SOURCE}`, {
      baseRevision: 1,
      document: coolifyDoc({ id: SOURCE }),
    });
    expect((await refusalsOf(foreign))[0]).toMatchObject({ code: 'BINDING_ID_MISMATCH' });
  });

  it('writes an epodsystem target by its label, the store being its connection', async () => {
    bindingMem.connections.set(COOLIFY_CONNECTION, {
      id: COOLIFY_CONNECTION,
      provider: 'epodsystem',
      ownerType: 'org',
      ownerId: ORG,
      active: true,
    });
    const doc = coolifyDoc({ target: { provider: 'epodsystem', label: 'shop-eu' } });
    const res = await call('PUT', `/bindings/${BINDING}`, { baseRevision: null, document: doc });
    expect(res.status).toBe(200);
    expect(bindingMem.rows.get(BINDING)).toMatchObject({
      provider: 'epodsystem',
      label: 'shop-eu',
      config: {},
    });
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
      label: '',
      agentAccess: 'none',
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
  for (const provider of ['', 'bitbucket']) {
    it(`refuses provider ${JSON.stringify(provider)} naming every provider it does define`, async () => {
      const doc = coolifyDoc({ target: { provider } });
      const res = await call('PUT', `/bindings/${BINDING}`, { baseRevision: null, document: doc });
      expect(res.status).toBe(422);
      expect(await refusalsOf(res)).toEqual([
        {
          code: 'SCHEMA_VIOLATION',
          path: '/target/provider',
          detail: `provider ${JSON.stringify(provider)} is not a binding target; target.provider is one of coolify, shopify, epodsystem, github, gitlab, sentry, postman, rocketchat, google, agent, each with the fields binding-v1.json names for it.`,
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
    branch: 'main',
    resourceName: 'shop',
  };

  beforeEach(() => {
    seedBindingRow({
      id: BINDING,
      projectId: PROJECT,
      connectionId: COOLIFY_CONNECTION,
      provider: 'coolify',
      role: 'deploy',
      config: held,
      label: '',
      agentAccess: 'none',
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
        revision: 2,
        reason: expect.stringContaining('`branch`, `resourceName`'),
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

describe('a target the provider is asked about', () => {
  it('asks the provider about the target before writing, and writes nothing it refuses', async () => {
    effects.targetRefusals.mockResolvedValueOnce([
      {
        code: 'COOLIFY_APPLICATION_UNKNOWN',
        path: '/target/applications/0/resourceUuid',
        detail: 'Coolify has no application "y8w4c4kss8ogo8gc44ow44kc"',
      },
    ]);
    const res = await call('PUT', `/bindings/${BINDING}`, {
      baseRevision: null,
      document: coolifyDoc(),
    });
    expect(res.status).toBe(422);
    expect(await refusalsOf(res)).toEqual([
      expect.objectContaining({
        code: 'COOLIFY_APPLICATION_UNKNOWN',
        path: '/target/applications/0/resourceUuid',
      }),
    ]);
    expect(effects.targetRefusals).toHaveBeenCalledWith({
      projectId: expect.any(String),
      connectionId: COOLIFY_CONNECTION,
      provider: 'coolify',
      config: { targets: [expect.objectContaining({ resourceUuid: 'y8w4c4kss8ogo8gc44ow44kc' })] },
      held: null,
    });
    expect(bindingMem.rows.size).toBe(0);
  });

  it('hands the provider what the row already holds on the same connection, so only new targets are asked about', async () => {
    const held = {
      targets: [{ id: 'primary', label: 'primary', resourceUuid: 'y8w4c4kss8ogo8gc44ow44kc' }],
    };
    seedBindingRow({
      id: BINDING,
      projectId: PROJECT,
      connectionId: COOLIFY_CONNECTION,
      provider: 'coolify',
      role: 'deploy',
      config: held,
      label: '',
      agentAccess: 'none',
      active: true,
      revision: 1,
    });
    const res = await call('PUT', `/bindings/${BINDING}`, {
      baseRevision: 1,
      document: coolifyDoc(),
    });
    expect(res.status).toBe(200);
    expect(effects.targetRefusals).toHaveBeenCalledWith(expect.objectContaining({ held }));
  });

  it('hands the provider nothing held once the document names another connection, so every target is asked about', async () => {
    const previous = '13131313-1313-4131-8131-131313131313';
    bindingMem.connections.set(previous, {
      id: previous,
      provider: 'coolify',
      ownerType: 'org',
      ownerId: ORG,
      active: true,
    });
    seedBindingRow({
      id: BINDING,
      projectId: PROJECT,
      connectionId: previous,
      provider: 'coolify',
      role: 'deploy',
      config: {
        targets: [{ id: 'primary', label: 'primary', resourceUuid: 'y8w4c4kss8ogo8gc44ow44kc' }],
      },
      label: '',
      agentAccess: 'none',
      active: true,
      revision: 1,
    });
    const res = await call('PUT', `/bindings/${BINDING}`, {
      baseRevision: 1,
      document: coolifyDoc(),
    });
    expect(res.status).toBe(200);
    expect(effects.targetRefusals).toHaveBeenCalledWith(
      expect.objectContaining({ connectionId: COOLIFY_CONNECTION, held: null }),
    );
  });

  it('asks the provider nothing when the document is already refused', async () => {
    const res = await call('PUT', `/bindings/${BINDING}`, {
      baseRevision: null,
      document: coolifyDoc({ connection: '12121212-1212-4121-8121-121212121212' }),
    });
    expect(res.status).toBe(422);
    expect(effects.targetRefusals).not.toHaveBeenCalled();
  });
});

// ISS-34 — a binding is switched off through the binding-v1 path alone, with its revision, its
// refusals and its effects; the integrations route that soft-deleted the row directly is gone.
