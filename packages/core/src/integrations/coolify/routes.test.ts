/**
 * ISS-1279 — what a person pressing "confirm prod deploy" is told when the
 * environment is already being deployed to.
 *
 * `middleware/error.ts:errorHandler` turns anything that is not an
 * `HTTPException` into a bare `INTERNAL_ERROR` with no message in production,
 * so a refusal that is not mapped here does not reach the one surface it was
 * written for. That is the whole subject of this file.
 */

import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config/env.js', () => ({
  env: {
    JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef',
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://localhost/stub',
  },
}));

vi.mock('../../db/client.js', () => ({ db: {} }));

const confirmMock = vi.fn();
vi.mock('../../pipeline/release-coolify.js', () => ({
  confirmPendingProdDeploy: (...a: unknown[]) => confirmMock(...(a as [])),
}));

vi.mock('../route-helpers.js', () => ({
  assertProjectMember: async () => 'admin',
  assertAdmin: () => undefined,
  broadcastIntegrationChanged: vi.fn(),
  notFound: () => new Error('not found'),
}));

const BINDING_ID = 'b2222222-2222-4222-8222-222222222222';
const PROJECT_ID = '11111111-1111-4111-8111-111111111111';

vi.mock('../store.js', () => ({
  findBindingWithConnectionById: async () => ({
    binding: { id: BINDING_ID, projectId: PROJECT_ID, stages: ['live'] },
    connection: { id: 'conn-1' },
  }),
  buildContextFromBinding: () => ({ config: {}, secrets: {} }),
}));

vi.mock('./commands.js', () => ({
  CoolifyCommandError: class extends Error {},
  coolifyDeliveryStatus: vi.fn(),
  listCoolifyIntegrations: vi.fn(),
  runCoolifyDeploy: vi.fn(),
}));

vi.mock('./controls.js', () => ({
  credentialFromSecrets: vi.fn(),
  fetchCoolifyApplications: vi.fn(),
  listCoolifyRollbackImages: vi.fn(),
  resolveCoolifyTargets: vi.fn(),
  runCoolifyCancel: vi.fn(),
  runCoolifyRollback: vi.fn(),
}));

const { registerCoolifyDeployRoutes } = await import('./routes.js');
const { DeployEnvironmentLockedError } = await import('../../pipeline/deploy-lock.js');
const { errorHandler } = await import('../../middleware/error.js');

// biome-ignore lint/suspicious/noExplicitAny: the handler's Variables generic is not this file's subject
const app = new Hono<any>();
registerCoolifyDeployRoutes(app);
app.use('*', async (c, next) => {
  c.set('userId', 'user-1');
  await next();
});
// biome-ignore lint/suspicious/noExplicitAny: see above
app.onError(errorHandler as any);

const confirm = () =>
  app.request(`/${PROJECT_ID}/integrations/${BINDING_ID}/confirm-prod-deploy`, {
    method: 'POST',
  });

const holder = {
  projectId: PROJECT_ID,
  environment: 'live',
  runId: 'run-holding',
  subject: 'live deploy (binding b-7)',
  acquiredAt: '2026-09-26T10:00:00.000Z',
  expiresAt: '2026-09-26T10:30:00.000Z',
};

beforeEach(() => vi.clearAllMocks());

describe('POST confirm-prod-deploy, when the environment is held', () => {
  it('answers 409 and not the 500 an unmapped refusal would give', async () => {
    confirmMock.mockRejectedValueOnce(new DeployEnvironmentLockedError('live', holder));

    expect((await confirm()).status).toBe(409);
  });

  it('answers with the refusal code rather than INTERNAL_ERROR', async () => {
    confirmMock.mockRejectedValueOnce(new DeployEnvironmentLockedError('live', holder));

    const body = (await (await confirm()).json()) as { code: string };

    expect(body.code).toBe('DEPLOY_ENVIRONMENT_LOCKED');
  });

  it('carries the holder, the subject and what ends the hold through to the body', async () => {
    confirmMock.mockRejectedValueOnce(new DeployEnvironmentLockedError('live', holder));

    const body = (await (await confirm()).json()) as { message: string };

    expect(body.message).toContain('run-holding');
    expect(body.message).toContain('live deploy (binding b-7)');
    expect(body.message).toContain('2026-09-26T10:30:00.000Z');
  });

  it('answers 200 with the result when nothing holds the environment', async () => {
    confirmMock.mockResolvedValueOnce({
      confirmed: true,
      runId: 'run-1',
      integrationId: BINDING_ID,
    });

    const res = await confirm();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      confirmed: true,
      runId: 'run-1',
      integrationId: BINDING_ID,
    });
  });
});

/** ISS-1346 — a Coolify refusal reaches the REST caller as what Coolify said, not INTERNAL_ERROR. */
describe('GET rollback-images, when Coolify refuses the read', () => {
  const images = () =>
    app.request(`/${PROJECT_ID}/integrations/coolify/rollback-images?resourceUuid=app-uuid`);

  it('answers 502 naming the status and the Coolify route', async () => {
    const { listCoolifyRollbackImages } = await import('./controls.js');
    const { CoolifyApiError } = await import('./client.js');
    vi.mocked(listCoolifyRollbackImages).mockRejectedValueOnce(
      new CoolifyApiError(
        404,
        '{}',
        undefined,
        'GET /api/v1/applications/app-uuid/rollback-images',
      ),
    );
    const res = await images();
    expect(res.status).toBe(502);
    const body = JSON.stringify(await res.json());
    expect(body).toContain('COOLIFY_API_ERROR');
    expect(body).toContain(
      'Coolify answered HTTP 404 to GET /api/v1/applications/app-uuid/rollback-images',
    );
  });
});
