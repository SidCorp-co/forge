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
