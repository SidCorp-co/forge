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

/**
 * ISS-1346 — a Coolify refusal reaches the REST caller as what Coolify said, not INTERNAL_ERROR.
 * ISS-1194 — and as a status Cloudflare lets through: it replaces an origin 502's body with its own
 * `error code: 502`, which is how this read's refusal stayed invisible on the live tracker.
 */
describe('GET rollback-images, when Coolify refuses the read', () => {
  const images = () =>
    app.request(`/${PROJECT_ID}/integrations/coolify/rollback-images?resourceUuid=app-uuid`);

  /** Coolify's own answer, made by the real client against a stubbed fetch. */
  const coolifyAnswers = async (status: number, body: string) => {
    const { CoolifyClient } = await import('./client.js');
    const client = new CoolifyClient({
      baseUrl: 'https://coolify.example',
      apiToken: 'tok',
      fetchImpl: (async () => new Response(body, { status })) as typeof fetch,
    });
    const { listCoolifyRollbackImages } = await import('./controls.js');
    vi.mocked(listCoolifyRollbackImages).mockImplementationOnce(async () => {
      await client.listRollbackImages('app-uuid');
      throw new Error('the stubbed Coolify answer was a refusal');
    });
  };

  it('answers a status Cloudflare does not replace, never the 502 it turns into its own page', async () => {
    await coolifyAnswers(404, '{"message":"Not found."}');
    const res = await images();
    expect(res.status).toBe(424);
    expect([502, 504]).not.toContain(res.status);
  });

  it('names that Forge got no rollback image list, with the status, route and body Coolify gave, and does not claim which 404 it was', async () => {
    await coolifyAnswers(404, '{"message":"Not found."}');
    const body = (await (await images()).json()) as { code: string; message: string };
    expect(body.code).toBe('COOLIFY_API_ERROR');
    expect(body.message).toContain(
      'Coolify answered HTTP 404 to GET /api/v1/applications/app-uuid/rollback-images',
    );
    expect(body.message).toContain('no rollback image list to read and no tag to roll back to');
    expect(body.message).toContain('lacks the route or does not know the application');
    expect(body.message).toContain('Not found.');
  });

  it('names the status and route for a refusal that is not a missing list', async () => {
    await coolifyAnswers(500, 'boom');
    const res = await images();
    expect(res.status).toBe(424);
    const body = (await res.json()) as { message: string };
    expect(body.message).toBe(
      'Coolify answered HTTP 500 to GET /api/v1/applications/app-uuid/rollback-images',
    );
  });

  it('names the missing ability for a 403, as the other Coolify routes do', async () => {
    await coolifyAnswers(403, '{}');
    const res = await images();
    expect(res.status).toBe(424);
    expect(JSON.stringify(await res.json())).toContain('`read` ability');
  });

  /** The transport's own failure, through the real client and the helper the controls call it by. */
  const transportFails = async (fetchImpl: typeof fetch, timeoutMs?: number) => {
    const { CoolifyClient } = await import('./client.js');
    const { readRollbackImagesNamingFailure } = await import('./rollback-images-read.js');
    const client = new CoolifyClient({
      baseUrl: 'https://coolify.example',
      apiToken: 'tok',
      fetchImpl,
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    });
    const { listCoolifyRollbackImages } = await import('./controls.js');
    vi.mocked(listCoolifyRollbackImages).mockImplementationOnce(async () => {
      await readRollbackImagesNamingFailure(client, 'app-uuid');
      throw new Error('the stubbed Coolify answer was a failure');
    });
  };

  it('answers 424 naming an unreachable Coolify, not a 500', async () => {
    await transportFails((async () => {
      throw new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } });
    }) as typeof fetch);
    const res = await images();
    expect(res.status).toBe(424);
    const body = (await res.json()) as { code: string; message: string };
    expect(body.code).toBe('COOLIFY_UNREACHABLE');
    expect(body.message).toContain('Could not reach Coolify');
    expect(body.message).toContain('GET /api/v1/applications/app-uuid/rollback-images');
    expect(body.message).not.toContain('<uuid>');
  });

  it('answers 424 naming a Coolify that timed out, not a 500', async () => {
    await transportFails(
      ((_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          );
        })) as unknown as typeof fetch,
      5,
    );
    const res = await images();
    expect(res.status).toBe(424);
    const body = (await res.json()) as { code: string; message: string };
    expect(body.code).toBe('COOLIFY_UNREACHABLE');
    expect(body.message).toContain('Coolify timed out');
    expect(body.message).toContain('GET /api/v1/applications/app-uuid/rollback-images');
    expect(body.message).not.toContain('<uuid>');
  });

  it('answers 424 naming a 200 that is not JSON, not a 500', async () => {
    await transportFails((async () => new Response('<html>', { status: 200 })) as typeof fetch);
    const res = await images();
    expect(res.status).toBe(424);
    const body = (await res.json()) as { code: string; message: string };
    expect(body.code).toBe('COOLIFY_ANSWER_NOT_JSON');
    expect(body.code).not.toBe('COOLIFY_UNREACHABLE');
    expect(body.message).toContain('something that is not JSON');
    expect(body.message).toContain('GET /api/v1/applications/app-uuid/rollback-images');
    expect(body.message).not.toContain('<uuid>');
  });

  it('still answers 400 for a caller error, which is not Coolify refusing anything', async () => {
    const { listCoolifyRollbackImages } = await import('./controls.js');
    const { CoolifyCommandError } = await import('./commands.js');
    vi.mocked(listCoolifyRollbackImages).mockRejectedValueOnce(
      new CoolifyCommandError('project has no active Coolify integration'),
    );
    expect((await images()).status).toBe(400);
  });

  it('answers 200 with the images when Coolify lists them', async () => {
    const { listCoolifyRollbackImages } = await import('./controls.js');
    const listed = {
      integrationId: BINDING_ID,
      resourceUuid: 'app-uuid',
      targetLabel: 'Backend',
      current: 'sha-b',
      images: [{ tag: 'sha-b', createdAt: null, isCurrent: true }],
    };
    vi.mocked(listCoolifyRollbackImages).mockResolvedValueOnce(listed);
    const res = await images();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(listed);
  });
});

/** ISS-1194 — the 424 is this one read's; the other Coolify routes keep what ISS-1346 gave them. */
describe('the other Coolify routes, when Coolify refuses', () => {
  it('still answer 502 naming the status and the Coolify route', async () => {
    const { coolifyDeliveryStatus } = await import('./commands.js');
    const { CoolifyApiError } = await import('./client.js');
    vi.mocked(coolifyDeliveryStatus).mockRejectedValueOnce(
      new CoolifyApiError(500, '{}', undefined, 'GET /api/v1/resources'),
    );
    const res = await app.request(`/${PROJECT_ID}/integrations/coolify/status`);
    expect(res.status).toBe(502);
    expect(JSON.stringify(await res.json())).toContain(
      'Coolify answered HTTP 500 to GET /api/v1/resources',
    );
  });
});
