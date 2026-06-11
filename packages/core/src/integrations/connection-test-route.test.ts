// ISS-435 — POST /api/integration-connections/:id/test (connection-scoped
// healthcheck for the workspace directory drawer). Separate file from
// routes.test.ts because this suite mocks `./registry.js` (the adapter), which
// the main suite deliberately leaves real.
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_SECRET = 'test-secret-at-least-32-chars-long-abcdef';

vi.mock('../config/env.js', () => ({
  env: { JWT_SECRET: TEST_SECRET, NODE_ENV: 'test' },
}));

const selectLimit = vi.fn();
const selectWhere = vi.fn(() => ({ limit: selectLimit }));
const selectOrderBy = vi.fn();
const selectFrom = vi.fn(() => ({
  where: selectWhere,
  orderBy: selectOrderBy,
}));

vi.mock('../db/client.js', () => ({
  db: {
    select: vi.fn(() => ({ from: selectFrom })),
  },
}));

const findConnectionById = vi.fn();
const listBindingsForConnection = vi.fn();
const buildContextFromBinding = vi.fn();

vi.mock('./store.js', () => ({
  createConnection: vi.fn(),
  createBinding: vi.fn(),
  findActiveBinding: vi.fn(),
  findBindingWithConnectionById: vi.fn(),
  findConnectionById: (id: string) => findConnectionById(id),
  updateConnection: vi.fn(),
  updateBinding: vi.fn(),
  softDeleteBinding: vi.fn(),
  softDeleteConnection: vi.fn(),
  listBindingsForProject: vi.fn(),
  listBindingsForConnection: (id: string) => listBindingsForConnection(id),
  listConnectionsForPrincipalUser: vi.fn(),
  listActiveBindingsForProjectProvider: vi.fn(),
  buildContextFromBinding: (pair: unknown) => buildContextFromBinding(pair),
  effectiveConfig: vi.fn(() => ({})),
}));

const healthcheck = vi.fn();
const getAdapter = vi.fn();

vi.mock('./registry.js', () => ({
  getAdapter: (provider: string) => getAdapter(provider),
}));

const orgRoleMock = vi.fn();
vi.mock('../lib/authz.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/authz.js')>()),
  effectiveProjectRole: vi.fn(),
  loadOrgRole: (...args: unknown[]) => orgRoleMock(...args),
}));

const { integrationConnectionsRoutes } = await import('./routes.js');
const { signUserToken } = await import('../auth/jwt.js');
const { errorHandler } = await import('../middleware/error.js');
const { requestId } = await import('../middleware/request-id.js');

function buildApp() {
  const app = new Hono<{ Variables: import('../middleware/request-id.js').RequestIdVars }>();
  app.use('*', requestId());
  app.route('/api/integration-connections', integrationConnectionsRoutes);
  app.onError(errorHandler);
  return app;
}

const USER_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_USER = '99999999-9999-4999-8999-999999999999';
const CONN_ID = '33333333-3333-4333-8333-333333333333';
const ORG_ID = '55555555-5555-4555-8555-555555555555';

function ownedConnection(overrides: Record<string, unknown> = {}) {
  return {
    id: CONN_ID,
    ownerType: 'user',
    ownerId: USER_ID,
    provider: 'postman',
    displayName: null,
    config: {},
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

function bindingPair(overrides: Record<string, unknown> = {}, createdAt = new Date()) {
  return {
    binding: {
      id: 'bind-1',
      connectionId: CONN_ID,
      projectId: '22222222-2222-4222-8222-222222222222',
      provider: 'postman',
      environment: 'prod',
      config: {},
      integrationSecret: 'whsec_x',
      active: true,
      createdAt,
      updatedAt: createdAt,
      ...overrides,
    },
    connection: ownedConnection(),
  };
}

function testReq(token: string, id: string) {
  return buildApp().request(`/api/integration-connections/${id}/test`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  selectLimit.mockReset();
  orgRoleMock.mockReset();
  getAdapter.mockReturnValue({ healthcheck });
});

function mockVerifiedEmail() {
  selectLimit.mockResolvedValueOnce([{ emailVerifiedAt: new Date() }]);
}

describe('POST /api/integration-connections/:id/test', () => {
  it('200 — probes through the OLDEST active binding and returns the adapter result', async () => {
    const token = await signUserToken(USER_ID);
    mockVerifiedEmail();
    findConnectionById.mockResolvedValueOnce(ownedConnection());
    // newest-first (the store's ordering); the oldest active row must win.
    const newest = bindingPair({ id: 'bind-new' }, new Date('2026-06-10'));
    const oldestInactive = bindingPair({ id: 'bind-dead', active: false }, new Date('2026-06-01'));
    const oldestActive = bindingPair({ id: 'bind-old' }, new Date('2026-06-05'));
    listBindingsForConnection.mockResolvedValueOnce([newest, oldestActive, oldestInactive]);
    buildContextFromBinding.mockReturnValueOnce({ ctx: true });
    healthcheck.mockResolvedValueOnce({ status: 'ok', message: 'authenticated' });

    const res = await testReq(token, CONN_ID);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok', message: 'authenticated' });
    const probedPair = buildContextFromBinding.mock.calls[0]?.[0] as {
      binding: { id: string };
    };
    expect(probedPair.binding.id).toBe('bind-old');
    expect(healthcheck).toHaveBeenCalledWith({ ctx: true });
  });

  it('404 NO_BINDING — no active binding to probe through', async () => {
    const token = await signUserToken(USER_ID);
    mockVerifiedEmail();
    findConnectionById.mockResolvedValueOnce(ownedConnection());
    listBindingsForConnection.mockResolvedValueOnce([
      bindingPair({ id: 'bind-dead', active: false }),
    ]);

    const res = await testReq(token, CONN_ID);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('NO_BINDING');
    expect(healthcheck).not.toHaveBeenCalled();
  });

  it('404 — non-owner of a user-owned connection (no existence leak)', async () => {
    const token = await signUserToken(USER_ID);
    mockVerifiedEmail();
    findConnectionById.mockResolvedValueOnce(ownedConnection({ ownerId: OTHER_USER }));

    const res = await testReq(token, CONN_ID);
    expect(res.status).toBe(404);
    expect(listBindingsForConnection).not.toHaveBeenCalled();
  });

  it('403 — plain org member on an org-owned connection', async () => {
    const token = await signUserToken(USER_ID);
    mockVerifiedEmail();
    findConnectionById.mockResolvedValueOnce(
      ownedConnection({ ownerType: 'org', ownerId: ORG_ID }),
    );
    orgRoleMock.mockResolvedValueOnce('member');

    const res = await testReq(token, CONN_ID);
    expect(res.status).toBe(403);
    expect(listBindingsForConnection).not.toHaveBeenCalled();
  });

  it('400 NO_ADAPTER — provider without a registered adapter', async () => {
    const token = await signUserToken(USER_ID);
    mockVerifiedEmail();
    findConnectionById.mockResolvedValueOnce(ownedConnection());
    listBindingsForConnection.mockResolvedValueOnce([bindingPair()]);
    getAdapter.mockReturnValueOnce(undefined);

    const res = await testReq(token, CONN_ID);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('NO_ADAPTER');
  });
});
