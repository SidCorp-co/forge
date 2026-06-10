import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

const createConnection = vi.fn();
const createBinding = vi.fn();
const findActiveBinding = vi.fn();
const findBindingWithConnectionById = vi.fn();
const findConnectionById = vi.fn();
const updateConnection = vi.fn();
const updateBinding = vi.fn();
const softDeleteBinding = vi.fn();
const softDeleteConnection = vi.fn();
const listBindingsForProject = vi.fn();
const listBindingsForConnection = vi.fn();
const listConnectionsForOwner = vi.fn();
const listActiveBindingsForProjectProvider = vi.fn();
const findDeliveryById = vi.fn();
const enqueueCoolifyDispatch = vi.fn();

vi.mock('./deliveries.js', () => ({
  findDeliveryById: (id: string) => findDeliveryById(id),
}));

vi.mock('./queue.js', () => ({
  enqueueCoolifyDispatch: (job: unknown) => enqueueCoolifyDispatch(job),
}));

vi.mock('./store.js', () => ({
  createConnection: (a: unknown) => createConnection(a),
  createBinding: (a: unknown) => createBinding(a),
  findActiveBinding: (...a: unknown[]) => findActiveBinding(...(a as [])),
  findBindingWithConnectionById: (id: string) => findBindingWithConnectionById(id),
  findConnectionById: (id: string) => findConnectionById(id),
  updateConnection: (id: string, patch: unknown) => updateConnection(id, patch),
  updateBinding: (id: string, patch: unknown) => updateBinding(id, patch),
  softDeleteBinding: (id: string) => softDeleteBinding(id),
  softDeleteConnection: (id: string) => softDeleteConnection(id),
  listBindingsForProject: (id: string) => listBindingsForProject(id),
  listBindingsForConnection: (id: string) => listBindingsForConnection(id),
  listConnectionsForPrincipalUser: (id: string) => listConnectionsForOwner(id),
  listActiveBindingsForProjectProvider: (...a: unknown[]) =>
    listActiveBindingsForProjectProvider(...(a as [])),
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
const { encryptJson } = await import('./vault.js');

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

function post(token: string, body: unknown) {
  return buildApp().request(`/api/projects/${PROJECT_ID}/integrations`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
}

function patch(token: string, id: string, body: unknown) {
  return buildApp().request(`/api/projects/${PROJECT_ID}/integrations/${id}`, {
    method: 'PATCH',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
}

const VALID_BODY = {
  provider: 'coolify',
  environment: 'staging',
  config: {
    baseUrl: 'https://coolify.example.com',
    resourceUuid: 'res-abc-123',
    branch: 'main',
  },
  secrets: { apiToken: 'tok-abcdef12' },
};

// Fixed 32-byte base64 key for the configured-vault case.
const TEST_KEY_B64 = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';

const ORIGINAL_KEY = process.env.INTEGRATION_MASTER_KEY;

afterEach(() => {
  if (ORIGINAL_KEY === undefined) delete process.env.INTEGRATION_MASTER_KEY;
  else process.env.INTEGRATION_MASTER_KEY = ORIGINAL_KEY;
});

beforeEach(() => {
  vi.clearAllMocks();
  selectLimit.mockReset();
  effectiveRole.mockReset();
  orgRoleMock.mockReset();
});

describe('POST /api/projects/:projectId/integrations — vault guard', () => {
  it('503 VAULT_NOT_CONFIGURED when INTEGRATION_MASTER_KEY is unset', async () => {
    delete process.env.INTEGRATION_MASTER_KEY;
    const token = await signUserToken(USER_ID);
    mockOwnerMembership();

    const res = await post(token, VALID_BODY);
    expect(res.status).toBe(503);
    const body = (await res.json()) as { code: string; message: string };
    expect(body.code).toBe('VAULT_NOT_CONFIGURED');
    expect(body.message).toMatch(/INTEGRATION_MASTER_KEY/);
    expect(createConnection).not.toHaveBeenCalled();
  });

  it('201 + integrationSecret when vault is configured (happy path)', async () => {
    process.env.INTEGRATION_MASTER_KEY = TEST_KEY_B64;
    const token = await signUserToken(USER_ID);
    mockOwnerMembership();
    findActiveBinding.mockResolvedValueOnce(null); // no clash
    createConnection.mockResolvedValueOnce({
      id: 'conn-1',
      provider: 'coolify',
      config: { ...VALID_BODY.config, environment: 'staging' },
      active: true,
      lastHealthStatus: null,
      lastHealthAt: null,
      breakerOpenedAt: null,
      secretsEnc: Buffer.from('enc'),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    createBinding.mockResolvedValueOnce({
      id: 'int-1',
      projectId: PROJECT_ID,
      provider: 'coolify',
      environment: 'staging',
      config: {},
      integrationSecret: 'whsec_xxx',
      active: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const res = await post(token, VALID_BODY);
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      integration: { id: string; provider: string };
      integrationSecret: string;
    };
    expect(body.integration.id).toBe('int-1'); // binding id
    expect(body.integrationSecret).toMatch(/^whsec_/);
    expect(createConnection).toHaveBeenCalledTimes(1);
    expect(createBinding).toHaveBeenCalledTimes(1);
  });
});

describe('POST /api/projects/:projectId/integrations — postman provider schema', () => {
  const POSTMAN_BODY = {
    provider: 'postman',
    environment: 'prod',
    config: {
      workspaceName: 'Forge Integration',
      collectionId: 'col-123',
      region: 'eu',
      mode: 'minimal',
    },
    secrets: { apiKey: 'PMAK-abcdef123456' },
  };

  it('201 — accepts a valid postman integration and never echoes the key', async () => {
    process.env.INTEGRATION_MASTER_KEY = TEST_KEY_B64;
    const token = await signUserToken(USER_ID);
    mockOwnerMembership();
    findActiveBinding.mockResolvedValueOnce(null);
    createConnection.mockResolvedValueOnce({
      id: 'conn-pm',
      provider: 'postman',
      config: { ...POSTMAN_BODY.config, workspaceName: 'Forge Integration', environment: 'prod' },
      active: true,
      lastHealthStatus: null,
      lastHealthAt: null,
      breakerOpenedAt: null,
      secretsEnc: Buffer.from('enc'),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    createBinding.mockResolvedValueOnce({
      id: 'int-pm',
      projectId: PROJECT_ID,
      provider: 'postman',
      environment: 'prod',
      config: {},
      integrationSecret: 'whsec_pm',
      active: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const res = await post(token, POSTMAN_BODY);
    expect(res.status).toBe(201);
    const raw = await res.text();
    // The API key must never appear anywhere in the response.
    expect(raw).not.toContain('PMAK-abcdef123456');
    const body = JSON.parse(raw) as { integration: { id: string; provider: string } };
    expect(body.integration.provider).toBe('postman');
    // The credential is stored on the connection — verify the key was passed to
    // createConnection (and never echoed back).
    expect(createConnection).toHaveBeenCalledTimes(1);
    const arg = createConnection.mock.calls[0]?.[0] as { secrets: { apiKey: string } };
    expect(arg.secrets.apiKey).toBe('PMAK-abcdef123456');
  });

  it('400 — rejects a postman body missing the apiKey secret', async () => {
    process.env.INTEGRATION_MASTER_KEY = TEST_KEY_B64;
    const token = await signUserToken(USER_ID);
    mockOwnerMembership();

    const res = await post(token, { ...POSTMAN_BODY, secrets: {} });
    expect(res.status).toBe(400);
    expect(createConnection).not.toHaveBeenCalled();
  });

  it('400 — rejects an invalid region', async () => {
    process.env.INTEGRATION_MASTER_KEY = TEST_KEY_B64;
    const token = await signUserToken(USER_ID);
    mockOwnerMembership();

    const res = await post(token, {
      ...POSTMAN_BODY,
      config: { ...POSTMAN_BODY.config, region: 'apac' },
    });
    expect(res.status).toBe(400);
    expect(createConnection).not.toHaveBeenCalled();
  });

  it('PATCH — a partial config does NOT reset region/mode to defaults', async () => {
    const token = await signUserToken(USER_ID);
    mockOwnerMembership();
    // Existing eu/full integration; PATCH only the collectionId. Config lives on
    // the connection; the binding carries the project/env link.
    findBindingWithConnectionById.mockResolvedValue({
      binding: {
        id: 'int-pm',
        projectId: PROJECT_ID,
        provider: 'postman',
        environment: 'prod',
        config: {},
        integrationSecret: null,
        active: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      connection: {
        id: 'conn-pm',
        provider: 'postman',
        config: {
          workspaceName: 'Forge Integration',
          region: 'eu',
          mode: 'full',
          environment: 'prod',
        },
        secretsEnc: Buffer.from('enc'),
        active: true,
        lastHealthStatus: null,
        lastHealthAt: null,
        breakerOpenedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });
    updateConnection.mockResolvedValueOnce({ id: 'conn-pm' });

    const res = await patch(token, 'int-pm', { config: { collectionId: 'col-new' } });
    expect(res.status).toBe(200);
    expect(updateConnection).toHaveBeenCalledTimes(1);
    const [connId, updatePatch] = updateConnection.mock.calls[0] as [
      string,
      { config: Record<string, unknown> },
    ];
    expect(connId).toBe('conn-pm');
    // The eu/full target must be preserved — only collectionId changes.
    expect(updatePatch.config).toMatchObject({
      region: 'eu',
      mode: 'full',
      collectionId: 'col-new',
    });
  });
});

describe('PATCH — apiKey-provider rotation persists previousApiKey + expiry (ISS-405)', () => {
  function mockPostmanBinding(secretsEnc: Buffer) {
    findBindingWithConnectionById.mockResolvedValue({
      binding: {
        id: 'int-pm',
        projectId: PROJECT_ID,
        provider: 'postman',
        environment: 'prod',
        config: {},
        integrationSecret: null,
        active: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      connection: {
        id: 'conn-pm',
        provider: 'postman',
        config: { workspaceName: 'W', region: 'us', mode: 'minimal', environment: 'prod' },
        secretsEnc,
        active: true,
        lastHealthStatus: null,
        lastHealthAt: null,
        breakerOpenedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });
  }

  function mockEpodsystemConnection(secretsEnc: Buffer) {
    findConnectionById.mockResolvedValue({
      id: 'conn-ep',
      provider: 'epodsystem',
      ownerType: 'user',
      ownerId: USER_ID,
      displayName: 'Store',
      config: { environment: 'prod' },
      secretsEnc,
      active: true,
      lastHealthStatus: null,
      lastHealthAt: null,
      breakerOpenedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }

  it('per-binding PATCH (postman): old apiKey is preserved as previousApiKey + future expiry', async () => {
    process.env.INTEGRATION_MASTER_KEY = TEST_KEY_B64;
    const token = await signUserToken(USER_ID);
    mockOwnerMembership();
    mockPostmanBinding(encryptJson({ apiKey: 'PMAK-old-key' }));
    updateConnection.mockResolvedValueOnce({ id: 'conn-pm' });

    const before = Date.now();
    const res = await patch(token, 'int-pm', { secrets: { apiKey: 'PMAK-new-key' } });
    expect(res.status).toBe(200);
    expect(updateConnection).toHaveBeenCalledTimes(1);
    const [, updatePatch] = updateConnection.mock.calls[0] as [
      string,
      { secrets: Record<string, unknown> },
    ];
    expect(updatePatch.secrets).toMatchObject({
      apiKey: 'PMAK-new-key',
      previousApiKey: 'PMAK-old-key',
    });
    const expiresAt = Date.parse(String(updatePatch.secrets.previousTokenExpiresAt));
    expect(expiresAt).toBeGreaterThan(before);
    // 24h rotation window — allow generous slack for slow CI clocks.
    expect(expiresAt - before).toBeGreaterThan(23 * 60 * 60_000);
    expect(expiresAt - before).toBeLessThan(25 * 60 * 60_000);
  });

  it('per-binding PATCH (postman): config-only update does NOT touch secrets', async () => {
    process.env.INTEGRATION_MASTER_KEY = TEST_KEY_B64;
    const token = await signUserToken(USER_ID);
    mockOwnerMembership();
    mockPostmanBinding(encryptJson({ apiKey: 'PMAK-old-key' }));
    updateConnection.mockResolvedValueOnce({ id: 'conn-pm' });

    const res = await patch(token, 'int-pm', { config: { collectionId: 'col-new' } });
    expect(res.status).toBe(200);
    const [, updatePatch] = updateConnection.mock.calls[0] as [
      string,
      { config?: object; secrets?: unknown },
    ];
    expect(updatePatch.secrets).toBeUndefined();
  });

  it('connection-level PATCH (epodsystem): old apiKey is preserved as previousApiKey + future expiry', async () => {
    process.env.INTEGRATION_MASTER_KEY = TEST_KEY_B64;
    const token = await signUserToken(USER_ID);
    // selectLimit only stacks emailVerified for connection-level routes (no
    // project-member assertion — connections are owner-scoped).
    selectLimit.mockResolvedValueOnce([{ emailVerifiedAt: new Date() }]);
    mockEpodsystemConnection(encryptJson({ apiKey: 'crmk_old' }));
    updateConnection.mockResolvedValueOnce({
      id: 'conn-ep',
      provider: 'epodsystem',
      displayName: 'Store',
      config: { environment: 'prod' },
      active: true,
      lastHealthStatus: null,
      lastHealthAt: null,
      breakerOpenedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const before = Date.now();
    const res = await buildApp().request('/api/integration-connections/conn-ep', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ secrets: { apiKey: 'crmk_new' } }),
    });
    expect(res.status).toBe(200);
    expect(updateConnection).toHaveBeenCalledTimes(1);
    const [connId, updatePatch] = updateConnection.mock.calls[0] as [
      string,
      { secrets: Record<string, unknown> },
    ];
    expect(connId).toBe('conn-ep');
    expect(updatePatch.secrets).toMatchObject({
      apiKey: 'crmk_new',
      previousApiKey: 'crmk_old',
    });
    const expiresAt = Date.parse(String(updatePatch.secrets.previousTokenExpiresAt));
    expect(expiresAt).toBeGreaterThan(before);
    expect(expiresAt - before).toBeGreaterThan(23 * 60 * 60_000);
    expect(expiresAt - before).toBeLessThan(25 * 60 * 60_000);
  });

  it('per-binding PATCH (coolify): existing rotation behavior unchanged (regression guard)', async () => {
    process.env.INTEGRATION_MASTER_KEY = TEST_KEY_B64;
    const token = await signUserToken(USER_ID);
    mockOwnerMembership();
    findBindingWithConnectionById.mockResolvedValue({
      binding: {
        id: 'int-cl',
        projectId: PROJECT_ID,
        provider: 'coolify',
        environment: 'staging',
        config: {},
        integrationSecret: null,
        active: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      connection: {
        id: 'conn-cl',
        provider: 'coolify',
        config: {
          baseUrl: 'https://coolify.example',
          resourceUuid: 'res-1',
          branch: 'main',
          environment: 'staging',
        },
        secretsEnc: encryptJson({ apiToken: 'tok-old' }),
        active: true,
        lastHealthStatus: null,
        lastHealthAt: null,
        breakerOpenedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });
    updateConnection.mockResolvedValueOnce({ id: 'conn-cl' });

    const res = await patch(token, 'int-cl', { secrets: { apiToken: 'tok-new-123' } });
    expect(res.status).toBe(200);
    const [, updatePatch] = updateConnection.mock.calls[0] as [
      string,
      { secrets: Record<string, unknown> },
    ];
    expect(updatePatch.secrets).toMatchObject({
      apiToken: 'tok-new-123',
      previousApiToken: 'tok-old',
    });
    expect(updatePatch.secrets.previousTokenExpiresAt).toBeTypeOf('string');
  });
});

// === ISS-406 F2 — bind-existing + bindings-list + delivery-retry ===

const CONN_ID = '33333333-3333-4333-8333-333333333333';
const OTHER_USER = '99999999-9999-4999-8999-999999999999';

function ownedConnection(overrides: Record<string, unknown> = {}) {
  return {
    id: CONN_ID,
    ownerType: 'user',
    ownerId: USER_ID,
    provider: 'coolify',
    displayName: null,
    config: { baseUrl: 'https://coolify.example.com', resourceUuid: 'res-1', branch: 'main' },
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

describe('POST /api/integration-connections/:id/bindings — bind existing connection', () => {
  it('201 — binds an existing connection to a project+env with no secret body', async () => {
    const token = await signUserToken(USER_ID);
    mockOwnerMembership(); // emailVerified + target-project owner
    findConnectionById.mockResolvedValueOnce(ownedConnection());
    findActiveBinding.mockResolvedValueOnce(null);
    createBinding.mockResolvedValueOnce({
      id: 'bind-1',
      connectionId: CONN_ID,
      projectId: PROJECT_ID,
      provider: 'coolify',
      environment: 'staging',
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

    const res = await bindReq(token, CONN_ID, { projectId: PROJECT_ID, environment: 'staging' });
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

  it('409 — provider+env clash on an existing active binding', async () => {
    const token = await signUserToken(USER_ID);
    mockOwnerMembership();
    findConnectionById.mockResolvedValueOnce(ownedConnection());
    findActiveBinding.mockResolvedValueOnce({ binding: { id: 'existing' }, connection: {} });

    const res = await bindReq(token, CONN_ID, { projectId: PROJECT_ID, environment: 'staging' });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('ALREADY_EXISTS');
    expect(createBinding).not.toHaveBeenCalled();
  });

  it('404 — non-owner of the connection (no existence leak)', async () => {
    const token = await signUserToken(USER_ID);
    selectLimit.mockResolvedValueOnce([{ emailVerifiedAt: new Date() }]);
    findConnectionById.mockResolvedValueOnce(ownedConnection({ ownerId: OTHER_USER }));

    const res = await bindReq(token, CONN_ID, { projectId: PROJECT_ID, environment: 'staging' });
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

    const res = await bindReq(token, CONN_ID, { projectId: PROJECT_ID, environment: 'staging' });
    expect(res.status).toBe(403);
    expect(createBinding).not.toHaveBeenCalled();
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
          environment: 'staging',
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
          environment: 'prod',
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

describe('POST /api/projects/:projectId/integrations/:id/deliveries/:deliveryId/retry', () => {
  function retryReq(token: string, id: string, deliveryId: string) {
    return buildApp().request(
      `/api/projects/${PROJECT_ID}/integrations/${id}/deliveries/${deliveryId}/retry`,
      { method: 'POST', headers: { authorization: `Bearer ${token}` } },
    );
  }

  const binding = {
    binding: { id: 'bind-1', projectId: PROJECT_ID, provider: 'coolify', environment: 'staging' },
    connection: ownedConnection(),
  };

  it('202 — re-dispatches a failed outbound delivery with a fresh requestId', async () => {
    const token = await signUserToken(USER_ID);
    mockOwnerMembership();
    findBindingWithConnectionById.mockResolvedValueOnce(binding);
    findDeliveryById.mockResolvedValueOnce({
      id: 'del-1',
      bindingId: 'bind-1',
      direction: 'outbound',
      status: 'failed',
      eventName: 'release.deploy',
      payload: { runId: 'run-1', issueId: 'iss-1' },
    });
    enqueueCoolifyDispatch.mockResolvedValueOnce('job-1');

    const res = await retryReq(token, 'bind-1', 'del-1');
    expect(res.status).toBe(202);
    const body = (await res.json()) as { requestId: string; queued: boolean };
    expect(body.queued).toBe(true);
    expect(body.requestId).toMatch(/^retry_/);
    expect(enqueueCoolifyDispatch).toHaveBeenCalledTimes(1);
    const job = enqueueCoolifyDispatch.mock.calls[0]?.[0] as {
      bindingId: string;
      eventName: string;
      requestId: string;
      runId: string | null;
      issueId: string | null;
    };
    expect(job.bindingId).toBe('bind-1');
    expect(job.eventName).toBe('release.deploy');
    expect(job.requestId).toMatch(/^retry_/);
    expect(job.runId).toBe('run-1');
    expect(job.issueId).toBe('iss-1');
  });

  it('409 — refuses a non-failed (ok) outbound delivery', async () => {
    const token = await signUserToken(USER_ID);
    mockOwnerMembership();
    findBindingWithConnectionById.mockResolvedValueOnce(binding);
    findDeliveryById.mockResolvedValueOnce({
      id: 'del-2',
      bindingId: 'bind-1',
      direction: 'outbound',
      status: 'ok',
      eventName: 'release.deploy',
      payload: {},
    });

    const res = await retryReq(token, 'bind-1', 'del-2');
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('NOT_RETRYABLE');
    expect(enqueueCoolifyDispatch).not.toHaveBeenCalled();
  });

  it('409 — refuses an inbound delivery', async () => {
    const token = await signUserToken(USER_ID);
    mockOwnerMembership();
    findBindingWithConnectionById.mockResolvedValueOnce(binding);
    findDeliveryById.mockResolvedValueOnce({
      id: 'del-3',
      bindingId: 'bind-1',
      direction: 'inbound',
      status: 'failed',
      eventName: 'webhook.in',
      payload: {},
    });

    const res = await retryReq(token, 'bind-1', 'del-3');
    expect(res.status).toBe(409);
    expect(enqueueCoolifyDispatch).not.toHaveBeenCalled();
  });

  it('404 — delivery belongs to a different binding', async () => {
    const token = await signUserToken(USER_ID);
    mockOwnerMembership();
    findBindingWithConnectionById.mockResolvedValueOnce(binding);
    findDeliveryById.mockResolvedValueOnce({
      id: 'del-4',
      bindingId: 'some-other-binding',
      direction: 'outbound',
      status: 'failed',
      eventName: 'release.deploy',
      payload: {},
    });

    const res = await retryReq(token, 'bind-1', 'del-4');
    expect(res.status).toBe(404);
    expect(enqueueCoolifyDispatch).not.toHaveBeenCalled();
  });
});

// === ISS-429 — MCP injection preview ===

describe('GET /api/projects/:projectId/integrations/mcp-preview', () => {
  function previewReq(token: string) {
    return buildApp().request(`/api/projects/${PROJECT_ID}/integrations/mcp-preview`, {
      headers: { authorization: `Bearer ${token}` },
    });
  }

  function postmanPair(over: { bindingActive?: boolean; secretsEnc?: string | null } = {}) {
    return {
      binding: {
        id: 'bind-pm',
        connectionId: CONN_ID,
        projectId: PROJECT_ID,
        provider: 'postman',
        environment: 'prod',
        config: {},
        integrationSecret: null,
        active: over.bindingActive ?? true,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      connection: ownedConnection({
        provider: 'postman',
        config: { region: 'eu', mode: 'full' },
        secretsEnc: over.secretsEnc === undefined ? 'enc-bytes' : over.secretsEnc,
      }),
    };
  }

  it('200 — injectable postman binding renders the resolver URL with a redacted header', async () => {
    const token = await signUserToken(USER_ID);
    mockOwnerMembership();
    const pair = postmanPair();
    listBindingsForProject.mockResolvedValueOnce([pair]);
    // The resolver pick query — called once per MCP provider.
    listActiveBindingsForProjectProvider.mockImplementation((_pid: string, provider: string) =>
      Promise.resolve(provider === 'postman' ? [pair] : []),
    );

    const res = await previewReq(token);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      servers: {
        provider: string;
        configured: boolean;
        willInject: boolean;
        reason: string;
        url: string | null;
        headers: Record<string, string> | null;
      }[];
    };
    const pm = body.servers.find((s) => s.provider === 'postman');
    expect(pm?.willInject).toBe(true);
    expect(pm?.reason).toBe('ok');
    // Same URL the dispatch resolver builds (region=eu, mode=full → /mcp path).
    expect(pm?.url).toBe('https://mcp.eu.postman.com/mcp');
    expect(pm?.headers?.Authorization).toBe('Bearer [redacted]');
    // No secret bytes anywhere in the payload.
    expect(JSON.stringify(body)).not.toContain('enc-bytes');
    // Unconfigured provider gets a synthetic row, not silence.
    const epod = body.servers.find((s) => s.provider === 'epodsystem');
    expect(epod?.configured).toBe(false);
    expect(epod?.reason).toBe('not_configured');
  });

  it('200 — disabled binding reads disabled and never willInject', async () => {
    const token = await signUserToken(USER_ID);
    mockOwnerMembership();
    listBindingsForProject.mockResolvedValueOnce([postmanPair({ bindingActive: false })]);
    listActiveBindingsForProjectProvider.mockResolvedValue([]);

    const res = await previewReq(token);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      servers: { provider: string; willInject: boolean; reason: string }[];
    };
    const pm = body.servers.find((s) => s.provider === 'postman');
    expect(pm?.willInject).toBe(false);
    expect(pm?.reason).toBe('disabled');
  });

  it('200 — active binding without a stored credential reads no_credential', async () => {
    const token = await signUserToken(USER_ID);
    mockOwnerMembership();
    const pair = postmanPair({ secretsEnc: null });
    listBindingsForProject.mockResolvedValueOnce([pair]);
    listActiveBindingsForProjectProvider.mockImplementation((_pid: string, provider: string) =>
      Promise.resolve(provider === 'postman' ? [pair] : []),
    );

    const res = await previewReq(token);
    const body = (await res.json()) as {
      servers: { provider: string; willInject: boolean; reason: string; headers: unknown }[];
    };
    const pm = body.servers.find((s) => s.provider === 'postman');
    expect(pm?.willInject).toBe(false);
    expect(pm?.reason).toBe('no_credential');
    expect(pm?.headers).toBeNull();
  });
});
