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

const createIntegration = vi.fn();
const findById = vi.fn();
const updateIntegration = vi.fn();
const softDeleteIntegration = vi.fn();
const listForProjectProvider = vi.fn();
const buildContext = vi.fn();

vi.mock('./store.js', () => ({
  createIntegration: (args: unknown) => createIntegration(args),
  findById: (id: string) => findById(id),
  updateIntegration: (id: string, patch: unknown) => updateIntegration(id, patch),
  softDeleteIntegration: (id: string) => softDeleteIntegration(id),
  listForProjectProvider: (projectId: string, provider: string) =>
    listForProjectProvider(projectId, provider),
  buildContext: (row: unknown) => buildContext(row),
}));

const { integrationsRoutes } = await import('./routes.js');
const { signUserToken } = await import('../auth/jwt.js');
const { errorHandler } = await import('../middleware/error.js');
const { requestId } = await import('../middleware/request-id.js');

function buildApp() {
  const app = new Hono<{ Variables: import('../middleware/request-id.js').RequestIdVars }>();
  app.use('*', requestId());
  app.route('/api/projects', integrationsRoutes);
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
    expect(createIntegration).not.toHaveBeenCalled();
  });

  it('201 + integrationSecret when vault is configured (happy path)', async () => {
    process.env.INTEGRATION_MASTER_KEY = TEST_KEY_B64;
    const token = await signUserToken(USER_ID);
    mockOwnerMembership();
    createIntegration.mockResolvedValueOnce({
      id: 'int-1',
      projectId: PROJECT_ID,
      provider: 'coolify',
      environment: 'staging',
      config: { ...VALID_BODY.config, environment: 'staging' },
      active: true,
      lastHealthStatus: null,
      lastHealthAt: null,
      breakerOpenedAt: null,
      secretsEnc: Buffer.from('enc'),
      integrationSecret: 'whsec_xxx',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const res = await post(token, VALID_BODY);
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      integration: { id: string; provider: string };
      integrationSecret: string;
    };
    expect(body.integration.id).toBe('int-1');
    expect(body.integrationSecret).toMatch(/^whsec_/);
    expect(createIntegration).toHaveBeenCalledTimes(1);
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
    createIntegration.mockResolvedValueOnce({
      id: 'int-pm',
      projectId: PROJECT_ID,
      provider: 'postman',
      environment: 'prod',
      config: { ...POSTMAN_BODY.config, workspaceName: 'Forge Integration', environment: 'prod' },
      active: true,
      lastHealthStatus: null,
      lastHealthAt: null,
      breakerOpenedAt: null,
      secretsEnc: Buffer.from('enc'),
      integrationSecret: 'whsec_pm',
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
    // The encrypted config the store persisted carries the target, not the key.
    expect(createIntegration).toHaveBeenCalledTimes(1);
    const arg = createIntegration.mock.calls[0]?.[0] as { secrets: { apiKey: string } };
    expect(arg.secrets.apiKey).toBe('PMAK-abcdef123456');
  });

  it('400 — rejects a postman body missing the apiKey secret', async () => {
    process.env.INTEGRATION_MASTER_KEY = TEST_KEY_B64;
    const token = await signUserToken(USER_ID);
    mockOwnerMembership();

    const res = await post(token, { ...POSTMAN_BODY, secrets: {} });
    expect(res.status).toBe(400);
    expect(createIntegration).not.toHaveBeenCalled();
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
    expect(createIntegration).not.toHaveBeenCalled();
  });

  it('PATCH — a partial config does NOT reset region/mode to defaults', async () => {
    const token = await signUserToken(USER_ID);
    mockOwnerMembership();
    // Existing eu/full integration; PATCH only the collectionId.
    findById.mockResolvedValueOnce({
      id: 'int-pm',
      projectId: PROJECT_ID,
      provider: 'postman',
      config: { workspaceName: 'Forge Integration', region: 'eu', mode: 'full', environment: 'prod' },
      secretsEnc: Buffer.from('enc'),
    });
    updateIntegration.mockResolvedValueOnce({
      id: 'int-pm',
      projectId: PROJECT_ID,
      provider: 'postman',
      environment: 'prod',
      config: {
        workspaceName: 'Forge Integration',
        region: 'eu',
        mode: 'full',
        collectionId: 'col-new',
        environment: 'prod',
      },
      active: true,
      lastHealthStatus: null,
      lastHealthAt: null,
      breakerOpenedAt: null,
      secretsEnc: Buffer.from('enc'),
      integrationSecret: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const res = await patch(token, 'int-pm', { config: { collectionId: 'col-new' } });
    expect(res.status).toBe(200);
    expect(updateIntegration).toHaveBeenCalledTimes(1);
    const [, updatePatch] = updateIntegration.mock.calls[0] as [string, { config: Record<string, unknown> }];
    // The eu/full target must be preserved — only collectionId changes.
    expect(updatePatch.config).toMatchObject({ region: 'eu', mode: 'full', collectionId: 'col-new' });
  });
});
