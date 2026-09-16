/**
 * `integrationConnectionsRoutes` — the connection-scoped half of the integrations
 * API: binding an EXISTING connection to a project, and listing what one is bound
 * to. Its own file rather than `routes.test.ts`'s because it exercises a different
 * route module over a different resource, and because the project-scoped file had
 * grown past the size budget with these along for the ride.
 */

import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_SECRET = 'test-secret-at-least-32-chars-long-abcdef';

vi.mock('../config/env.js', () => ({
  env: { JWT_SECRET: TEST_SECRET, NODE_ENV: 'test', CORS_ORIGINS: 'http://localhost:3000' },
}));

const selectLimit = vi.fn();
const selectWhere = vi.fn(() => ({ limit: selectLimit }));
const selectOrderBy = vi.fn();
const selectFrom = vi.fn(() => ({ where: selectWhere, orderBy: selectOrderBy }));

vi.mock('../db/client.js', () => ({
  db: { select: vi.fn(() => ({ from: selectFrom })) },
}));

const createConnection = vi.fn();
const createBinding = vi.fn();
const findActiveBinding = vi.fn();
const findActiveServiceBinding = vi.fn();
const findActiveBindingByLabel = vi.fn();
const findBindingWithConnectionById = vi.fn();
const findConnectionById = vi.fn();
const listBindingsForConnection = vi.fn();

vi.mock('./store.js', () => ({
  createConnection: (a: unknown) => createConnection(a),
  createBinding: (a: unknown) => createBinding(a),
  findActiveBinding: (...a: unknown[]) => findActiveBinding(...(a as [])),
  findActiveServiceBinding: (...a: unknown[]) => findActiveServiceBinding(...(a as [])),
  findActiveBindingByLabel: (...a: unknown[]) => findActiveBindingByLabel(...(a as [])),
  findBindingWithConnectionById: (id: string) => findBindingWithConnectionById(id),
  findConnectionById: (id: string) => findConnectionById(id),
  listBindingsForConnection: (id: string) => listBindingsForConnection(id),
  updateConnection: vi.fn(),
  updateBinding: vi.fn(),
  softDeleteBinding: vi.fn(),
  softDeleteConnection: vi.fn(),
  listBindingsForProject: vi.fn(),
  listConnectionsForPrincipalUser: vi.fn(),
  listActiveBindingsForProjectProvider: vi.fn(),
  buildContextFromBinding: vi.fn(),
  // Real overlay so summaries carry the effective config.
  effectiveConfig: (pair: { connection: { config?: object }; binding: { config?: object } }) => ({
    ...(pair.connection.config ?? {}),
    ...(pair.binding.config ?? {}),
  }),
}));

// Org-level authz: stub the db-touching resolvers; pure helpers stay real.
const effectiveRole = vi.fn();
const orgRoleMock = vi.fn();
vi.mock('../lib/authz.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/authz.js')>()),
  effectiveProjectRole: (...args: unknown[]) => effectiveRole(...args),
  loadOrgRole: (...args: unknown[]) => orgRoleMock(...args),
}));

const { integrationsRoutes, integrationConnectionsRoutes } = await import('./routes.js');
const { signUserToken } = await import('../auth/jwt.js');
const { errorHandler } = await import('../middleware/error.js');
const { requestId } = await import('../middleware/request-id.js');

function buildApp() {
  const app = new Hono<{ Variables: import('../middleware/request-id.js').RequestIdVars }>();
  app.use('*', requestId());
  app.route('/api/projects', integrationsRoutes);
  app.route('/api/integration-connections', integrationConnectionsRoutes);
  app.onError(errorHandler);
  return app;
}

const USER_ID = '11111111-1111-4111-8111-111111111111';
const PROJECT_ID = '22222222-2222-4222-8222-222222222222';
const CONN_ID = '33333333-3333-4333-8333-333333333333';
const OTHER_USER = '99999999-9999-4999-8999-999999999999';

function mockOwnerMembership() {
  // Stack: emailVerified row, then assertProjectMember's effectiveProjectRole
  // resolution (project admin = the old "owner" shorthand).
  selectLimit.mockResolvedValueOnce([{ emailVerifiedAt: new Date() }]);
  effectiveRole.mockResolvedValueOnce({
    projectId: PROJECT_ID,
    orgId: 'org-1',
    role: 'admin',
    orgRole: 'owner',
  });
}

function ownedConnection(overrides: Record<string, unknown> = {}) {
  return {
    id: CONN_ID,
    ownerType: 'user',
    ownerId: USER_ID,
    provider: 'coolify',
    displayName: null,
    config: { baseUrl: 'https://coolify.example.com' },
    secretsEnc: Buffer.from('enc'),
    active: true,
    lastHealthStatus: null,
    lastHealthAt: null,
    breakerOpenedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function bindReq(token: string, id: string, body: unknown) {
  return buildApp().request(`/api/integration-connections/${id}/bindings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

function listBindingsReq(token: string, id: string) {
  return buildApp().request(`/api/integration-connections/${id}/bindings`, {
    method: 'GET',
    headers: { authorization: `Bearer ${token}` },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  selectLimit.mockReset();
  effectiveRole.mockReset();
  orgRoleMock.mockReset();
  findActiveBindingByLabel.mockReset();
  // `clearAllMocks` clears calls, not queued `…Once` implementations. A deploy
  // binding never consults `findActiveBinding` (ISS-1046 rule 3), so a `…Once`
  // queued by a deploy test would otherwise be answered to the NEXT service
  // test — which is how the service-clash case read 500 instead of 409.
  findActiveBinding.mockReset();
  findActiveServiceBinding.mockReset();
});

describe('POST /api/integration-connections/:id/bindings — bind existing connection', () => {
  it('201 — binds an existing connection to a project+env with no secret body', async () => {
    const token = await signUserToken(USER_ID);
    mockOwnerMembership(); // emailVerified + target-project owner
    findConnectionById.mockResolvedValueOnce(ownedConnection());
    createBinding.mockResolvedValueOnce({
      id: 'bind-1',
      connectionId: CONN_ID,
      projectId: PROJECT_ID,
      provider: 'coolify',
      role: 'deploy',
      stages: ['preview'],
      config: {},
      integrationSecret: 'whsec_x',
      active: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    // The route re-reads the pair after the post-bind healthcheck (ISS-429);
    // undefined → it falls back to the just-created pair. (A persistent
    // mockResolvedValue from earlier tests would otherwise leak in here —
    // clearAllMocks resets calls, not implementations.)
    findBindingWithConnectionById.mockResolvedValueOnce(undefined);

    const res = await bindReq(token, CONN_ID, {
      projectId: PROJECT_ID,
      role: 'deploy',
      stages: ['preview'],
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      integration: { id: string; connectionId: string };
      integrationSecret: string;
    };
    expect(body.integration.id).toBe('bind-1');
    expect(body.integration.connectionId).toBe(CONN_ID);
    expect(body.integrationSecret).toMatch(/^whsec_/);
    // No secret is created here — createConnection must NOT be involved.
    expect(createConnection).not.toHaveBeenCalled();
    const arg = createBinding.mock.calls[0]?.[0] as { connectionId: string; provider: string };
    expect(arg.connectionId).toBe(CONN_ID);
    expect(arg.provider).toBe('coolify');
  });

  it('201 — optional config keeps binding-tier overrides and drops connection-tier keys', async () => {
    const token = await signUserToken(USER_ID);
    mockOwnerMembership();
    findConnectionById.mockResolvedValueOnce(ownedConnection());
    createBinding.mockResolvedValueOnce({
      id: 'bind-2',
      connectionId: CONN_ID,
      projectId: PROJECT_ID,
      provider: 'coolify',
      role: 'deploy',
      stages: ['preview'],
      config: { targets: [{ id: 't-b', label: 'App', resourceUuid: 'res-b' }] },
      integrationSecret: 'whsec_x',
      active: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    findBindingWithConnectionById.mockResolvedValueOnce(undefined);

    const res = await bindReq(token, CONN_ID, {
      projectId: PROJECT_ID,
      role: 'deploy',
      stages: ['preview'],
      config: {
        baseUrl: 'https://other.example.com',
        targets: [{ label: 'App', resourceUuid: 'res-b' }],
      },
    });
    expect(res.status).toBe(201);
    const arg = createBinding.mock.calls[0]?.[0] as {
      config: { targets: Array<{ label: string; resourceUuid: string }>; baseUrl?: string };
    };
    // baseUrl must NOT shadow the shared connection endpoint per-binding.
    expect(arg.config.baseUrl).toBeUndefined();
    expect(arg.config.targets).toEqual([
      expect.objectContaining({ label: 'App', resourceUuid: 'res-b' }),
    ]);
  });

  it('409 — a second active SERVICE binding for the same provider clashes', async () => {
    const token = await signUserToken(USER_ID);
    mockOwnerMembership();
    findConnectionById.mockResolvedValueOnce(ownedConnection());
    findActiveServiceBinding.mockResolvedValueOnce({ binding: { id: 'existing' }, connection: {} });

    const res = await bindReq(token, CONN_ID, { projectId: PROJECT_ID, role: 'service' });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('ALREADY_EXISTS');
    expect(createBinding).not.toHaveBeenCalled();
  });

  // ISS-1046 rule 3: a stage may hold more than one deploy binding, so the
  // pre-flight that refuses a second SERVICE binding must NOT refuse this one.
  // Eight fleet projects carry two coolify deploy bindings apiece; the old
  // provider+environment uniqueness is what this replaced.
  it('201 — a second active DEPLOY binding on the same stage is allowed', async () => {
    const token = await signUserToken(USER_ID);
    mockOwnerMembership();
    findConnectionById.mockResolvedValueOnce(ownedConnection());
    createBinding.mockResolvedValueOnce({
      id: 'bind-2',
      projectId: PROJECT_ID,
      provider: 'coolify',
      role: 'deploy',
      stages: ['preview'],
      config: { targets: [{ id: 't-2', label: 'App', resourceUuid: 'res-b' }] },
      integrationSecret: null,
      active: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const res = await bindReq(token, CONN_ID, {
      projectId: PROJECT_ID,
      role: 'deploy',
      stages: ['preview'],
      config: { targets: [{ label: 'App', resourceUuid: 'res-b' }] },
    });
    expect(res.status).toBe(201);
    expect(createBinding).toHaveBeenCalled();
    // The rule itself: the service pre-flight is never consulted for a deploy
    // binding, so a project already carrying one cannot be refused a second.
    expect(findActiveServiceBinding).not.toHaveBeenCalled();
  });

  it('409 — Drizzle-wrapped 23505 on createBinding returns ALREADY_EXISTS (inactive duplicate)', async () => {
    const token = await signUserToken(USER_ID);
    mockOwnerMembership();
    findConnectionById.mockResolvedValueOnce(ownedConnection());
    findActiveServiceBinding.mockResolvedValueOnce(null); // no active duplicate — inactive row not caught by pre-flight
    const drizzleWrapped = Object.assign(
      new Error('Failed query: insert into integration_bindings'),
      {
        cause: { code: '23505' },
      },
    );
    createBinding.mockRejectedValueOnce(drizzleWrapped);

    const res = await bindReq(token, CONN_ID, {
      projectId: PROJECT_ID,
      role: 'deploy',
      stages: ['preview'],
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('ALREADY_EXISTS');
    expect(createConnection).not.toHaveBeenCalled();
  });

  it('404 — non-owner of the connection (no existence leak)', async () => {
    const token = await signUserToken(USER_ID);
    selectLimit.mockResolvedValueOnce([{ emailVerifiedAt: new Date() }]);
    findConnectionById.mockResolvedValueOnce(ownedConnection({ ownerId: OTHER_USER }));

    const res = await bindReq(token, CONN_ID, {
      projectId: PROJECT_ID,
      role: 'deploy',
      stages: ['preview'],
    });
    expect(res.status).toBe(404);
    expect(createBinding).not.toHaveBeenCalled();
  });

  it('403 — caller is only a member (not admin) of the target project', async () => {
    const token = await signUserToken(USER_ID);
    // emailVerified, then an effective role below admin on the target project.
    selectLimit.mockResolvedValueOnce([{ emailVerifiedAt: new Date() }]);
    effectiveRole.mockResolvedValueOnce({
      projectId: PROJECT_ID,
      orgId: 'org-1',
      role: 'member',
      orgRole: null,
    });
    findConnectionById.mockResolvedValueOnce(ownedConnection());

    const res = await bindReq(token, CONN_ID, {
      projectId: PROJECT_ID,
      role: 'deploy',
      stages: ['preview'],
    });
    expect(res.status).toBe(403);
    expect(createBinding).not.toHaveBeenCalled();
  });

  // cm:guard the capability check is the SERVER's, not only the screen's. The web form hides
  // "Deploy target" for a provider with no deploy adapter, but a hidden control is not a rule:
  // this door takes a JSON body from anything holding a token, and a `deploy` binding on a
  // provider Forge cannot deploy to is a release target that fails at deploy time with the merge
  // already pushed.
  it('400 — refuses `role: deploy` on a provider with no deploy adapter, by name', async () => {
    const token = await signUserToken(USER_ID);
    mockOwnerMembership();
    findConnectionById.mockResolvedValueOnce(ownedConnection({ provider: 'sentry' }));

    const res = await bindReq(token, CONN_ID, {
      projectId: PROJECT_ID,
      role: 'deploy',
      stages: ['live'],
    });
    expect(res.status).toBe(400);
    const body = JSON.stringify(await res.json());
    expect(body).toContain('Forge cannot deploy to');
    expect(body).toContain('sentry');
    // The refusal lists what CAN, so the caller is not left guessing.
    expect(body).toContain('coolify');
    expect(createBinding).not.toHaveBeenCalled();
  });

  it('201 — accepts that same provider as a `service` binding', async () => {
    const token = await signUserToken(USER_ID);
    mockOwnerMembership();
    findConnectionById.mockResolvedValueOnce(ownedConnection({ provider: 'sentry' }));
    findActiveServiceBinding.mockResolvedValueOnce(null);
    createBinding.mockResolvedValueOnce({
      id: 'bind-new',
      projectId: PROJECT_ID,
      provider: 'sentry',
      role: 'service',
      stages: [],
      config: {},
      active: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const res = await bindReq(token, CONN_ID, { projectId: PROJECT_ID, role: 'service' });
    expect(res.status).toBe(201);
  });
});

describe('GET /api/integration-connections/:id/bindings — bindings for a connection', () => {
  it('200 — returns all bindings for the connection', async () => {
    const token = await signUserToken(USER_ID);
    selectLimit.mockResolvedValueOnce([{ emailVerifiedAt: new Date() }]);
    findConnectionById.mockResolvedValueOnce(ownedConnection());
    listBindingsForConnection.mockResolvedValueOnce([
      {
        binding: {
          id: 'bind-a',
          projectId: PROJECT_ID,
          provider: 'coolify',
          role: 'deploy',
          stages: ['preview'],
          config: {},
          integrationSecret: 'whsec_a',
          active: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        connection: ownedConnection(),
      },
      {
        binding: {
          id: 'bind-b',
          projectId: '44444444-4444-4444-8444-444444444444',
          provider: 'coolify',
          role: 'service',
          config: {},
          integrationSecret: 'whsec_b',
          active: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        connection: ownedConnection(),
      },
    ]);

    const res = await listBindingsReq(token, CONN_ID);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: { id: string; connectionId: string }[] };
    expect(body.items).toHaveLength(2);
    expect(body.items.map((i) => i.id)).toEqual(['bind-a', 'bind-b']);
    expect(body.items.every((i) => i.connectionId === CONN_ID)).toBe(true);
  });

  it('404 — non-owner of the connection', async () => {
    const token = await signUserToken(USER_ID);
    selectLimit.mockResolvedValueOnce([{ emailVerifiedAt: new Date() }]);
    findConnectionById.mockResolvedValueOnce(ownedConnection({ ownerId: OTHER_USER }));

    const res = await listBindingsReq(token, CONN_ID);
    expect(res.status).toBe(404);
    expect(listBindingsForConnection).not.toHaveBeenCalled();
  });
});
