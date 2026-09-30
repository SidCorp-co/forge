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
const BETA = '3f1c2a9e-7b4d-4e21-9c1a-5d6e7f8a9b0c';
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
    source: { type: 'git' },
    environments: {
      dev: { tier: 'dev', deployment: { binding: BINDING, trigger: 'on-land' } },
      beta: { tier: 'production', deployment: { binding: BETA, trigger: 'on-land' } },
      shop: { tier: 'staging', deployment: { mode: 'external' } },
    },
  },
};

const serving = {
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
};

const broken = {
  adapter: {
    provider: 'coolify',
    latestDeployment: async () => {
      throw new Error('Coolify deployment d1: status "paused" is not one Forge maps');
    },
  },
  target: {},
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
    adapterFor.mockResolvedValueOnce(serving);
    const res = await get('dev');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      environment: 'dev',
      state: 'deployed',
      evidence: 'deployment-record',
      source: { kind: 'revision', revision: SHA },
      artifact: null,
    });
    expect(adapterFor).toHaveBeenCalledWith(PROJECT, BINDING, expect.any(Number));
  });

  it('answers unknown with its reason for an external environment, reaching no platform', async () => {
    const res = await get('shop');
    expect(await res.json()).toMatchObject({
      environment: 'shop',
      state: 'unknown',
      evidence: 'none',
      reason: { cause: 'external' },
    });
    expect(adapterFor).not.toHaveBeenCalled();
  });

  it('answers a platform that cannot be read as 200 unknown, naming the cause', async () => {
    adapterFor.mockResolvedValueOnce(broken);
    const res = await get('dev');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      state: 'unknown',
      reason: { cause: 'adapter-error', message: expect.stringContaining('"paused"') },
    });
  });

  it('answers a binding refusal as unknown carrying its code', async () => {
    adapterFor.mockRejectedValueOnce(
      new EnvironmentStateError('DEPLOY_HISTORY_UNSUPPORTED', 'binding x cannot read history'),
    );
    expect(await (await get('dev')).json()).toMatchObject({
      state: 'unknown',
      reason: {
        cause: 'binding-refused',
        message: expect.stringMatching(/^DEPLOY_HISTORY_UNSUPPORTED/),
      },
    });
  });

  it('refuses an environment the document does not declare, naming the ones it does', async () => {
    const res = await get('live');
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code: string; message: string };
    expect(body.code).toBe('ENVIRONMENT_NOT_FOUND');
    expect(body.message).toContain('declared: dev, beta, shop');
  });

  it('refuses a name every object inherits rather than reading it as a declaration', async () => {
    expect((await get('constructor')).status).toBe(404);
  });

  it('refuses a project with no stored document', async () => {
    readDoc.mockResolvedValueOnce(null);
    const res = await get('dev');
    expect(res.status).toBe(404);
    expect(((await res.json()) as { code: string }).code).toBe('PROJECT_DOCUMENT_NOT_FOUND');
  });

  it('refuses a malformed environment name', async () => {
    expect((await get('Dev_1')).status).toBe(400);
  });
});

describe('GET /api/projects/:id/environments/state', () => {
  const all = () => app.request(`/api/projects/${PROJECT}/environments/state`);

  it('answers every declared environment, one bad one leaving the others readable', async () => {
    adapterFor.mockImplementation(async (_p: string, binding: string) =>
      binding === BINDING ? serving : broken,
    );
    const res = await all();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      revision: number;
      environments: { environment: string; state: string; reason?: { cause: string } }[];
    };
    expect(body.revision).toBe(3);
    expect(body.environments.map((e) => [e.environment, e.state, e.reason?.cause])).toEqual([
      ['dev', 'deployed', undefined],
      ['beta', 'unknown', 'adapter-error'],
      ['shop', 'unknown', 'external'],
    ]);
  });

  it('checks viewer access and authentication first', async () => {
    access.mockRejectedValueOnce(Object.assign(new Error('nope'), { status: 404 }));
    await all();
    expect(authed).toHaveBeenCalled();
    expect(access).toHaveBeenCalledWith(PROJECT, 'user-1', 'viewer');
    expect(readDoc).not.toHaveBeenCalled();
  });

  it('refuses a malformed project id', async () => {
    expect((await app.request('/api/projects/nope/environments/state')).status).toBe(400);
  });
});
