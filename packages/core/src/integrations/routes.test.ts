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
const listConnectionsForOwner = vi.fn();

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
  listConnectionsForOwner: (id: string) => listConnectionsForOwner(id),
  buildContextFromBinding: vi.fn(),
  // Real overlay so summaries carry the effective config.
  effectiveConfig: (pair: { connection: { config?: object }; binding: { config?: object } }) => ({
    ...(pair.connection.config ?? {}),
    ...(pair.binding.config ?? {}),
  }),
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
  // Stack: emailVerified row, then assertProjectMember's project row (owner).
  // ownerId === USER_ID short-circuits the project_members lookup.
  selectLimit
    .mockResolvedValueOnce([{ emailVerifiedAt: new Date() }])
    .mockResolvedValueOnce([{ id: PROJECT_ID, ownerId: USER_ID }]);
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
        config: { workspaceName: 'Forge Integration', region: 'eu', mode: 'full', environment: 'prod' },
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
    expect(updatePatch.config).toMatchObject({ region: 'eu', mode: 'full', collectionId: 'col-new' });
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
