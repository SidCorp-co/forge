import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_SECRET = 'test-secret-at-least-32-chars-long-abcdef-123456';
const TEST_PEPPER = 'y'.repeat(32);

vi.mock('../config/env.js', () => ({
  env: { JWT_SECRET: TEST_SECRET, DEVICE_TOKEN_PEPPER: TEST_PEPPER, NODE_ENV: 'test' },
}));

const verifiedUser = { id: 'u-1', emailVerifiedAt: new Date() };

const selectLimit = vi.fn();
const selectWhere = vi.fn(() => ({ limit: selectLimit }));
const selectFrom = vi.fn(() => ({ where: selectWhere }));
const dbSelect = vi.fn(() => ({ from: selectFrom }));

vi.mock('../db/client.js', () => ({
  db: { select: dbSelect },
}));

const loadProjectAccessMock = vi.fn(async () => ({
  projectId: 'p-1',
  ownerId: 'u-1',
  role: 'owner' as const,
}));
vi.mock('../lib/project-access.js', () => ({
  loadProjectAccess: (...args: unknown[]) =>
    loadProjectAccessMock(...(args as [string, string])),
}));

const spawnMock = vi.fn(async () => ({ ok: true, jobId: 'pm-1' }) as const);
vi.mock('./spawner.js', () => ({
  spawnPmSession: (...args: unknown[]) => spawnMock(...(args as [unknown])),
}));

const { pmRoutes } = await import('./routes.js');
const { errorHandler } = await import('../middleware/error.js');
const { requestId } = await import('../middleware/request-id.js');
const { signUserToken } = await import('../auth/jwt.js');

function buildApp() {
  const app = new Hono<{ Variables: import('../middleware/request-id.js').RequestIdVars }>();
  app.use('*', requestId());
  app.route('/api/projects', pmRoutes);
  app.onError(errorHandler);
  return app;
}

function req(path: string, init: RequestInit & { token?: string } = {}) {
  const headers = new Headers(init.headers);
  if (init.token) headers.set('authorization', `Bearer ${init.token}`);
  if (!headers.has('content-type') && init.body) headers.set('content-type', 'application/json');
  const { token: _t, ...rest } = init;
  return new Request(`http://localhost${path}`, { ...rest, headers });
}

const validProjectId = '11111111-1111-4111-8111-111111111111';

beforeEach(() => {
  selectLimit.mockReset();
  spawnMock.mockReset();
  loadProjectAccessMock.mockReset();
  loadProjectAccessMock.mockResolvedValue({
    projectId: 'p-1',
    ownerId: 'u-1',
    role: 'owner',
  });
  spawnMock.mockResolvedValue({ ok: true, jobId: 'pm-1' });
});

describe('POST /api/projects/:projectId/pm/run', () => {
  it('401 without auth', async () => {
    const app = buildApp();
    const r = await app.fetch(
      req(`/api/projects/${validProjectId}/pm/run`, { method: 'POST' }),
    );
    expect(r.status).toBe(401);
  });

  it('200 with jobId for a project member', async () => {
    selectLimit.mockResolvedValueOnce([verifiedUser]); // assertEmailVerified
    const token = await signUserToken('u-1');
    const app = buildApp();
    const r = await app.fetch(
      req(`/api/projects/${validProjectId}/pm/run`, { method: 'POST', token }),
    );
    expect(r.status).toBe(200);
    const json = (await r.json()) as { ok: boolean; jobId: string };
    expect(json).toEqual({ ok: true, jobId: 'pm-1' });
    expect(spawnMock).toHaveBeenCalledWith({
      projectId: validProjectId,
      cause: 'operator',
      actorUserId: 'u-1',
    });
  });

  it('403 for non-member', async () => {
    selectLimit.mockResolvedValueOnce([verifiedUser]);
    loadProjectAccessMock.mockResolvedValueOnce({
      projectId: 'p-1',
      ownerId: 'someone-else',
      role: null,
    });
    const token = await signUserToken('u-1');
    const app = buildApp();
    const r = await app.fetch(
      req(`/api/projects/${validProjectId}/pm/run`, { method: 'POST', token }),
    );
    expect(r.status).toBe(403);
  });

  it('409 with code DISABLED when pm is off', async () => {
    selectLimit.mockResolvedValueOnce([verifiedUser]);
    spawnMock.mockResolvedValueOnce({ ok: false, reason: 'disabled' });
    const token = await signUserToken('u-1');
    const app = buildApp();
    const r = await app.fetch(
      req(`/api/projects/${validProjectId}/pm/run`, { method: 'POST', token }),
    );
    expect(r.status).toBe(409);
    const json = (await r.json()) as { code?: string };
    expect(json.code).toBe('DISABLED');
  });

  it('409 with code ALREADY_ACTIVE when a PM job is in flight', async () => {
    selectLimit.mockResolvedValueOnce([verifiedUser]);
    spawnMock.mockResolvedValueOnce({ ok: false, reason: 'already-active' });
    const token = await signUserToken('u-1');
    const app = buildApp();
    const r = await app.fetch(
      req(`/api/projects/${validProjectId}/pm/run`, { method: 'POST', token }),
    );
    expect(r.status).toBe(409);
    const json = (await r.json()) as { code?: string };
    expect(json.code).toBe('ALREADY_ACTIVE');
  });

  it('429 with code RATE_LIMITED when over budget', async () => {
    selectLimit.mockResolvedValueOnce([verifiedUser]);
    spawnMock.mockResolvedValueOnce({ ok: false, reason: 'rate-limited' });
    const token = await signUserToken('u-1');
    const app = buildApp();
    const r = await app.fetch(
      req(`/api/projects/${validProjectId}/pm/run`, { method: 'POST', token }),
    );
    expect(r.status).toBe(429);
    const json = (await r.json()) as { code?: string };
    expect(json.code).toBe('RATE_LIMITED');
  });
});
