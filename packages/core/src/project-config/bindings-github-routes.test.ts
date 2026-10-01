import type { MiddlewareHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { bindingMem, ORG, seedBindingRow } from './binding-store.fixture.js';
import { PROJECT, VIEWER } from './memory-store.fixture.js';

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
  afterWrite: vi.fn(async () => ({}) as Record<string, unknown>),
}));
vi.mock('./bind-effects.js', () => ({ bindEffects: effects }));

const { BINDING, call, coolifyDoc, refusalsOf, resetBindingWorld } = await import(
  './bindings-routes.fixture.js'
);

beforeEach(() => {
  effects.refusals.mockClear();
  effects.inboundSecret.mockClear();
  effects.afterWrite.mockClear();
  resetBindingWorld();
});

const GITHUB_CONNECTION = '44444444-4444-4444-8444-444444444444';
const githubDoc = (target: Record<string, unknown> = {}) =>
  coolifyDoc({
    role: 'service',
    connection: GITHUB_CONNECTION,
    agentAccess: 'all',
    target: { provider: 'github', installationId: 42, owner: 'acme', repo: 'shop', ...target },
  });

describe('a github binding, and the effects every binding write runs', () => {
  beforeEach(() => {
    bindingMem.connections.set(GITHUB_CONNECTION, {
      id: GITHUB_CONNECTION,
      provider: 'github',
      ownerType: 'org',
      ownerId: ORG,
      active: true,
    });
  });

  it('stores the repository identity, the agent grant and a minted inbound secret, then runs the bind effects', async () => {
    effects.afterWrite.mockResolvedValueOnce({ repoUrl: 'https://github.com/acme/shop' });
    const res = await call('PUT', `/bindings/${BINDING}`, {
      baseRevision: null,
      document: githubDoc({ releaseRunnerLabel: 'release' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      created: true,
      effects: { repoUrl: 'https://github.com/acme/shop' },
    });
    expect(bindingMem.rows.get(BINDING)).toMatchObject({
      provider: 'github',
      role: 'service',
      agentAccess: 'all',
      label: '',
      config: { installationId: 42, owner: 'acme', repo: 'shop', releaseRunnerLabel: 'release' },
    });
    expect(bindingMem.secrets.get(BINDING)).toBe('whsec_minted');
    expect(effects.inboundSecret).toHaveBeenCalledWith(GITHUB_CONNECTION);
    expect(effects.afterWrite).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'github',
        created: true,
        connectionId: GITHUB_CONNECTION,
      }),
    );
    const read = (await (await call('GET', `/bindings/${BINDING}`, undefined, VIEWER)).json()) as {
      document: unknown;
    };
    expect(read.document).toEqual({
      ...githubDoc({ releaseRunnerLabel: 'release' }),
      active: true,
    });
  });

  it('mints no second secret on an update, and tells the effects it was not a create', async () => {
    await call('PUT', `/bindings/${BINDING}`, { baseRevision: null, document: githubDoc() });
    const res = await call('PUT', `/bindings/${BINDING}`, {
      baseRevision: 1,
      document: githubDoc({ repo: 'shop-v2' }),
    });
    expect(res.status).toBe(200);
    expect(effects.inboundSecret).toHaveBeenCalledTimes(1);
    expect(effects.afterWrite).toHaveBeenLastCalledWith(
      expect.objectContaining({ created: false }),
    );
  });

  it('refuses what the bind effects refuse, minting and writing nothing', async () => {
    effects.refusals.mockResolvedValueOnce([
      { code: 'AGENT_ACCESS_NEEDS_ORG_ADMIN', path: '/agentAccess', detail: 'org admin' },
    ]);
    const res = await call('PUT', `/bindings/${BINDING}`, {
      baseRevision: null,
      document: githubDoc(),
    });
    expect(res.status).toBe(422);
    expect(await refusalsOf(res)).toEqual([
      expect.objectContaining({ code: 'AGENT_ACCESS_NEEDS_ORG_ADMIN', path: '/agentAccess' }),
    ]);
    expect(bindingMem.rows.size).toBe(0);
    expect(effects.inboundSecret).not.toHaveBeenCalled();
    expect(effects.afterWrite).not.toHaveBeenCalled();
  });

  it('refuses a github target without its repository identity', async () => {
    const res = await call('PUT', `/bindings/${BINDING}`, {
      baseRevision: null,
      document: coolifyDoc({
        role: 'service',
        connection: GITHUB_CONNECTION,
        target: { provider: 'github' },
      }),
    });
    expect(res.status).toBe(422);
    expect((await refusalsOf(res)).map((r) => r.path).sort()).toEqual([
      '/target/installationId',
      '/target/owner',
      '/target/repo',
    ]);
  });

  it('refuses a rollback on a target by name, pointing at the project document', async () => {
    const res = await call('PUT', `/bindings/${BINDING}`, {
      baseRevision: null,
      document: githubDoc({ rollback: 'git revert' }),
    });
    expect(await refusalsOf(res)).toEqual([
      {
        code: 'BINDING_ROLLBACK_MOVED',
        path: '/target/rollback',
        detail: expect.stringContaining('`rollback.strategy`'),
      },
    ]);
    expect(bindingMem.rows.size).toBe(0);
  });

  it('reads a stored rollback as unrepresentable, naming where rollback lives now', async () => {
    seedBindingRow({
      id: BINDING,
      projectId: PROJECT,
      connectionId: GITHUB_CONNECTION,
      provider: 'github',
      role: 'service',
      config: { installationId: 42, owner: 'acme', repo: 'shop', rollback: 'git revert' },
      label: '',
      agentAccess: 'none',
      active: true,
      revision: 1,
    });
    const body = (await (await call('GET', '/bindings', undefined, VIEWER)).json()) as {
      unrepresentable: { reason: string }[];
    };
    expect(body.unrepresentable[0]?.reason).toContain('`rollback.strategy`');
  });
});

describe('a binding switched off, or holding nothing a document would drop', () => {
  beforeEach(() => {
    bindingMem.connections.set(GITHUB_CONNECTION, {
      id: GITHUB_CONNECTION,
      provider: 'github',
      ownerType: 'org',
      ownerId: ORG,
      active: true,
    });
  });

  it('is declared switched off at its revision, and switched back on there', async () => {
    seedBindingRow({
      id: BINDING,
      projectId: PROJECT,
      connectionId: GITHUB_CONNECTION,
      provider: 'github',
      role: 'service',
      config: { installationId: 42, owner: 'acme', repo: 'shop' },
      label: '',
      agentAccess: 'none',
      active: false,
      instructions: 'answer in the thread',
      revision: 4,
    });
    expect(
      await (await call('GET', `/bindings/${BINDING}`, undefined, VIEWER)).json(),
    ).toMatchObject({
      declared: true,
      revision: 4,
      document: { active: false, instructions: 'answer in the thread' },
    });
    const fromNothing = await call('PUT', `/bindings/${BINDING}`, {
      baseRevision: null,
      document: githubDoc(),
    });
    expect((await refusalsOf(fromNothing))[0]).toMatchObject({ code: 'STALE_BASE' });
    const res = await call('PUT', `/bindings/${BINDING}`, {
      baseRevision: 4,
      document: { ...githubDoc(), active: true, instructions: 'answer in the thread' },
    });
    expect(res.status).toBe(200);
    expect(bindingMem.rows.get(BINDING)).toMatchObject({
      active: true,
      instructions: 'answer in the thread',
      revision: 5,
    });
  });

  it('switches a binding off and clears its instructions through the document, keeping the row', async () => {
    seedBindingRow({
      id: BINDING,
      projectId: PROJECT,
      connectionId: GITHUB_CONNECTION,
      provider: 'github',
      role: 'service',
      config: { installationId: 42, owner: 'acme', repo: 'shop' },
      label: '',
      agentAccess: 'all',
      active: true,
      instructions: 'answer in the thread',
      revision: 2,
    });
    const res = await call('PUT', `/bindings/${BINDING}`, {
      baseRevision: 2,
      document: { ...githubDoc(), active: false },
    });
    expect(res.status).toBe(200);
    expect(bindingMem.rows.get(BINDING)).toMatchObject({
      active: false,
      instructions: null,
      revision: 3,
    });
  });

  it('refuses empty instructions by name rather than storing a second way to say none', async () => {
    const res = await call('PUT', `/bindings/${BINDING}`, {
      baseRevision: null,
      document: { ...githubDoc(), instructions: '' },
    });
    expect(res.status).toBe(422);
    expect((await refusalsOf(res))[0]).toMatchObject({ path: '/instructions' });
    expect(bindingMem.rows.size).toBe(0);
  });

  it('lets a project admin who is no org admin put back the org connection the row already holds, and no other', async () => {
    bindingMem.orgAdmins.clear();
    seedBindingRow({
      id: BINDING,
      projectId: PROJECT,
      connectionId: GITHUB_CONNECTION,
      provider: 'github',
      role: 'service',
      config: { installationId: 42, owner: 'acme', repo: 'shop' },
      label: '',
      agentAccess: 'none',
      active: false,
      revision: 4,
    });
    const other = '99999999-9999-4999-8999-999999999999';
    bindingMem.connections.set(other, {
      id: other,
      provider: 'github',
      ownerType: 'org',
      ownerId: ORG,
      active: true,
    });
    const swapped = await call('PUT', `/bindings/${BINDING}`, {
      baseRevision: 4,
      document: { ...githubDoc(), connection: other },
    });
    expect((await refusalsOf(swapped))[0]).toMatchObject({
      code: 'CONNECTION_NOT_FOUND',
      detail: expect.stringContaining('takes an organisation admin'),
    });
    expect(bindingMem.rows.get(BINDING)).toMatchObject({
      connectionId: GITHUB_CONNECTION,
      active: false,
    });

    const back = await call('PUT', `/bindings/${BINDING}`, {
      baseRevision: 4,
      document: githubDoc(),
    });
    expect(back.status).toBe(200);
    expect(bindingMem.rows.get(BINDING)).toMatchObject({ active: true, revision: 5 });
  });

  it('fills a github row that names no repository, since nothing on it is lost', async () => {
    seedBindingRow({
      id: BINDING,
      projectId: PROJECT,
      connectionId: GITHUB_CONNECTION,
      provider: 'github',
      role: 'service',
      config: {},
      label: '',
      agentAccess: 'none',
      active: true,
      revision: 1,
    });
    const res = await call('PUT', `/bindings/${BINDING}`, {
      baseRevision: 1,
      document: githubDoc(),
    });
    expect(res.status).toBe(200);
    expect(bindingMem.rows.get(BINDING)?.config).toMatchObject({ owner: 'acme', repo: 'shop' });
  });
});
