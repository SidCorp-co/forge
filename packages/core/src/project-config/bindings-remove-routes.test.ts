// Switching a binding off: DELETE /api/projects/:id/bindings/:bindingId { baseRevision }.
import { readFileSync } from 'node:fs';
import type { MiddlewareHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { bindingMem, COOLIFY_CONNECTION, seedBindingRow } from './binding-store.fixture.js';
import { ADMIN, mem, PROJECT, VIEWER } from './memory-store.fixture.js';

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

const { BINDING, call, coolifyDoc, refusalsOf, resetBindingWorld } = await import(
  './bindings-routes.fixture.js'
);

beforeEach(() => {
  effects.refusals.mockClear();
  effects.inboundSecret.mockClear();
  effects.targetRefusals.mockClear();
  effects.afterWrite.mockClear();
  resetBindingWorld();
});

describe('removing a binding', () => {
  const SIM = '3f1c2a9e-7b4d-4e21-9c1a-5d6e7f8a9b0c';
  const declareSimProject = () =>
    mem.project.set(PROJECT, {
      revision: 1,
      document: JSON.parse(
        readFileSync(new URL('./fixtures/sim-forge-dev/project.json', import.meta.url), 'utf8'),
      ),
      updatedBy: ADMIN,
      updatedAt: new Date(),
    });

  it('switches it off at the revision it was read at, bumps the revision and runs its effects', async () => {
    await call('PUT', `/bindings/${BINDING}`, { baseRevision: null, document: coolifyDoc() });
    effects.afterWrite.mockClear();

    const res = await call('DELETE', `/bindings/${BINDING}`, { baseRevision: 1 });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ removed: true, bindingId: BINDING, revision: 2 });
    expect(bindingMem.rows.get(BINDING)).toMatchObject({ active: false, revision: 2 });
    expect(effects.afterWrite).toHaveBeenCalledWith(
      expect.objectContaining({ bindingId: BINDING, projectId: PROJECT, created: false }),
    );
  });

  it('refuses STALE_BASE and leaves the row on', async () => {
    await call('PUT', `/bindings/${BINDING}`, { baseRevision: null, document: coolifyDoc() });

    const res = await call('DELETE', `/bindings/${BINDING}`, { baseRevision: 7 });

    expect(res.status).toBe(422);
    expect(await refusalsOf(res)).toEqual([expect.objectContaining({ code: 'STALE_BASE' })]);
    expect(bindingMem.rows.get(BINDING)).toMatchObject({ active: true, revision: 1 });
  });

  it('refuses BINDING_IN_USE while the project document names it', async () => {
    declareSimProject();
    await call('PUT', `/bindings/${SIM}`, {
      baseRevision: null,
      document: coolifyDoc({ id: SIM }),
    });

    const res = await call('DELETE', `/bindings/${SIM}`, { baseRevision: 1 });

    expect(await refusalsOf(res)).toEqual([
      expect.objectContaining({
        code: 'BINDING_IN_USE',
        path: '/environments/beta/deployment/binding',
      }),
    ]);
    expect(bindingMem.rows.get(SIM)).toMatchObject({ active: true });
  });

  it('refuses the same switch-off written as a document, BINDING_IN_USE', async () => {
    declareSimProject();
    await call('PUT', `/bindings/${SIM}`, {
      baseRevision: null,
      document: coolifyDoc({ id: SIM }),
    });

    const res = await call('PUT', `/bindings/${SIM}`, {
      baseRevision: 1,
      document: coolifyDoc({ id: SIM, active: false }),
    });

    expect(await refusalsOf(res)).toEqual([
      expect.objectContaining({ code: 'BINDING_IN_USE', path: '/active' }),
    ]);
  });

  it('answers 404 for a binding this project does not hold, and 400 for a body with no baseRevision', async () => {
    expect((await call('DELETE', `/bindings/${BINDING}`, { baseRevision: 1 })).status).toBe(404);
    await call('PUT', `/bindings/${BINDING}`, { baseRevision: null, document: coolifyDoc() });
    const res = await call('DELETE', `/bindings/${BINDING}`, {});
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'CONFIG_WRITE_SHAPE' });
  });

  it('takes project admin', async () => {
    await call('PUT', `/bindings/${BINDING}`, { baseRevision: null, document: coolifyDoc() });
    expect((await call('DELETE', `/bindings/${BINDING}`, { baseRevision: 1 }, VIEWER)).status).toBe(
      403,
    );
  });
});

describe('removing a binding that has no document form', () => {
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

  it('is switched off by its id and revision all the same, keeping every key it holds', async () => {
    const res = await call('DELETE', `/bindings/${BINDING}`, { baseRevision: 2 });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ removed: true, bindingId: BINDING, revision: 3 });
    expect(bindingMem.rows.get(BINDING)).toMatchObject({
      active: false,
      revision: 3,
      config: held,
    });
    expect(effects.afterWrite).toHaveBeenCalledWith(
      expect.objectContaining({ bindingId: BINDING, config: held, created: false }),
    );
  });

  it('still refuses STALE_BASE for it, and leaves it on', async () => {
    const res = await call('DELETE', `/bindings/${BINDING}`, { baseRevision: 1 });

    expect(await refusalsOf(res)).toEqual([expect.objectContaining({ code: 'STALE_BASE' })]);
    expect(bindingMem.rows.get(BINDING)).toMatchObject({ active: true, revision: 2 });
  });
});
