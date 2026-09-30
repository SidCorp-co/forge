import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../config/env.js', () => ({
  env: {
    JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef',
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://localhost/stub',
  },
}));
vi.mock('../db/client.js', () => ({ db: {} }));

const authed = vi.fn();
vi.mock('../middleware/auth.js', () => ({
  requireAuth:
    () => async (c: { set: (k: string, v: string) => void }, next: () => Promise<void>) => {
      authed();
      c.set('userId', 'user-1');
      await next();
    },
  assertEmailVerified: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));

const access = vi.fn();
vi.mock('../lib/authz.js', () => ({
  assertProjectAccess: (...a: unknown[]) => access(...a),
}));

const readDoc = vi.fn();
vi.mock('./service.js', () => ({ readProjectDocument: (...a: unknown[]) => readDoc(...a) }));

const adapterFor = vi.fn();
vi.mock('./deploy-adapters/index.js', () => ({
  deployAdapterForBinding: (...a: unknown[]) => adapterFor(...a),
}));

const { environmentStateRoutes } = await import('./environment-state-routes.js');
const { EnvironmentStateError } = await import('./environment-state.js');
const { errorHandler } = await import('../middleware/error.js');

const PROJECT = '11111111-1111-4111-8111-111111111111';
const BINDING = '9d4e5f6a-7b8c-4d9e-8f0a-1b2c3d4e5f60';
const SHA = '47f061d78ca5ae2de8005f703fae0b8e8a454da3';

// biome-ignore lint/suspicious/noExplicitAny: the handler's Variables generic is not this file's subject
const app = new Hono<any>();
app.route('/api/projects', environmentStateRoutes);
// biome-ignore lint/suspicious/noExplicitAny: see above
app.onError(errorHandler as any);

const get = (name: string, project = PROJECT) =>
  app.request(`/api/projects/${project}/environments/${name}/state`);

const doc = {
  revision: 3,
  document: {
    environments: {
      dev: { tier: 'dev', deployment: { binding: BINDING, trigger: 'on-land' } },
      shop: { tier: 'production', deployment: { mode: 'external' } },
    },
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  readDoc.mockResolvedValue(doc);
});

describe('GET /api/projects/:id/environments/:name/state', () => {
  it('checks viewer access on the project before reading anything', async () => {
    access.mockRejectedValueOnce(Object.assign(new Error('nope'), { status: 404 }));
    await get('dev');
    expect(authed).toHaveBeenCalled();
    expect(access).toHaveBeenCalledWith(PROJECT, 'user-1', 'viewer');
    expect(readDoc).not.toHaveBeenCalled();
  });

  it("answers the environment's state from its deployment record", async () => {
    adapterFor.mockResolvedValueOnce({
      adapter: {
        provider: 'coolify',
        latestDeployment: async () => ({
          id: 'dep-1',
          status: 'succeeded',
          at: '2026-09-30T19:14:01.000Z',
          sourceRevision: SHA,
          artifact: null,
        }),
      },
      target: {},
    });
    const res = await get('dev');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      environment: 'dev',
      state: 'deployed',
      evidence: 'deployment-record',
      source: { revision: SHA },
      artifact: null,
    });
    expect(adapterFor).toHaveBeenCalledWith(PROJECT, BINDING, expect.any(Number));
  });

  it('answers unknown for an external environment without reaching a platform', async () => {
    const res = await get('shop');
    expect(await res.json()).toEqual({ environment: 'shop', state: 'unknown', evidence: 'none' });
    expect(adapterFor).not.toHaveBeenCalled();
  });

  it('refuses an environment the document does not declare, naming the ones it does', async () => {
    const res = await get('beta');
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code: string; message: string };
    expect(body.code).toBe('ENVIRONMENT_NOT_FOUND');
    expect(body.message).toContain('declared: dev, shop');
  });

  it('refuses a name every object inherits rather than reading it as a declaration', async () => {
    const res = await get('constructor');
    expect(res.status).toBe(404);
  });

  it('refuses a project with no stored document', async () => {
    readDoc.mockResolvedValueOnce(null);
    const res = await get('dev');
    expect(res.status).toBe(404);
    expect(((await res.json()) as { code: string }).code).toBe('PROJECT_DOCUMENT_NOT_FOUND');
  });

  it('answers a binding refusal as 409 carrying its code', async () => {
    adapterFor.mockRejectedValueOnce(
      new EnvironmentStateError('DEPLOY_HISTORY_UNSUPPORTED', 'binding x cannot read history'),
    );
    const res = await get('dev');
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe('DEPLOY_HISTORY_UNSUPPORTED');
  });

  it('answers a platform that cannot be read as 502 naming why', async () => {
    adapterFor.mockResolvedValueOnce({
      adapter: {
        provider: 'coolify',
        latestDeployment: async () => {
          throw new Error('Coolify deployment d1: status "paused" is not one Forge maps');
        },
      },
      target: {},
    });
    const res = await get('dev');
    expect(res.status).toBe(502);
    const body = (await res.json()) as { code: string; message: string };
    expect(body.code).toBe('DEPLOYMENT_RECORD_UNREADABLE');
    expect(body.message).toContain('"paused"');
  });

  it('refuses a malformed environment name', async () => {
    expect((await get('Dev_1')).status).toBe(400);
  });
});
