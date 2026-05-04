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

const insertReturning = vi.fn();
const insertValues = vi.fn(() => ({ returning: insertReturning }));
const dbInsert = vi.fn(() => ({ values: insertValues }));

const updateReturning = vi.fn();
const updateWhere = vi.fn(() => ({ returning: updateReturning }));
const updateSet = vi.fn(() => ({ where: updateWhere }));
const dbUpdate = vi.fn(() => ({ set: updateSet }));

vi.mock('../db/client.js', () => ({
  db: {
    select: dbSelect,
    insert: dbInsert,
    update: dbUpdate,
  },
}));

const hooksEmitMock = vi.fn(async () => {});
vi.mock('../pipeline/hooks.js', () => ({
  hooks: { emit: (...args: unknown[]) => hooksEmitMock(...(args as [never, never])) },
}));

const loadProjectAccessMock = vi.fn(async () => ({
  projectId: 'p-1',
  ownerId: 'u-1',
  role: 'owner' as const,
}));
vi.mock('../lib/project-access.js', () => ({
  loadProjectAccess: (...args: unknown[]) => loadProjectAccessMock(...(args as [string, string])),
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
  insertReturning.mockReset();
  insertValues.mockClear();
  updateReturning.mockReset();
  hooksEmitMock.mockClear();
});

describe('POST /api/projects/:projectId/pm/run', () => {
  it('401 without auth', async () => {
    const app = buildApp();
    const r = await app.fetch(req(`/api/projects/${validProjectId}/pm/run`, { method: 'POST' }));
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

describe('POST /api/projects/:projectId/pm/escalations/:decisionId/respond', () => {
  const decisionId = '22222222-2222-4222-8222-222222222222';
  const issueId = '33333333-3333-4333-8333-333333333333';
  const path = `/api/projects/${validProjectId}/pm/escalations/${decisionId}/respond`;

  it('401 without auth', async () => {
    const app = buildApp();
    const r = await app.fetch(
      req(path, { method: 'POST', body: JSON.stringify({ choice: 'approve' }) }),
    );
    expect(r.status).toBe(401);
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
      req(path, { method: 'POST', token, body: JSON.stringify({ choice: 'approve' }) }),
    );
    expect(r.status).toBe(403);
  });

  it('400 on invalid choice', async () => {
    selectLimit.mockResolvedValueOnce([verifiedUser]);
    const token = await signUserToken('u-1');
    const app = buildApp();
    const r = await app.fetch(
      req(path, { method: 'POST', token, body: JSON.stringify({ choice: 'bogus' }) }),
    );
    expect(r.status).toBe(400);
  });

  it('404 when the decision does not exist in this project', async () => {
    selectLimit
      .mockResolvedValueOnce([verifiedUser]) // assertEmailVerified
      .mockResolvedValueOnce([]); // pmDecisions lookup misses
    const token = await signUserToken('u-1');
    const app = buildApp();
    const r = await app.fetch(
      req(path, { method: 'POST', token, body: JSON.stringify({ choice: 'approve' }) }),
    );
    expect(r.status).toBe(404);
  });

  it('happy path: comments inserted, notifications marked read, follow-up spawn fired', async () => {
    selectLimit
      .mockResolvedValueOnce([verifiedUser]) // assertEmailVerified
      .mockResolvedValueOnce([{ id: decisionId, eventRef: { issueIds: [issueId] } }])
      .mockResolvedValueOnce([{ id: issueId, projectId: validProjectId }]);
    insertReturning.mockResolvedValueOnce([{ id: 'cmt-1', body: 'reply', parentId: null }]);
    updateReturning.mockResolvedValueOnce([{ id: 'notif-1', userId: 'u-1' }]);
    spawnMock.mockResolvedValueOnce({ ok: true, jobId: 'pm-2' });

    const token = await signUserToken('u-1');
    const app = buildApp();
    const r = await app.fetch(
      req(path, {
        method: 'POST',
        token,
        body: JSON.stringify({ choice: 'approve', comment: 'go ahead' }),
      }),
    );
    expect(r.status).toBe(200);
    const json = (await r.json()) as { ok: boolean; jobId: string };
    expect(json).toEqual({ ok: true, jobId: 'pm-2' });

    expect(insertValues).toHaveBeenCalledTimes(1);
    expect(insertValues.mock.calls[0]?.[0]).toMatchObject({
      issueId,
      authorId: 'u-1',
      parentId: null,
    });

    expect(spawnMock).toHaveBeenCalledWith({
      projectId: validProjectId,
      cause: 'operator-reply',
      eventRef: { decisionId, choice: 'approve', payload: {} },
      actorUserId: 'u-1',
    });

    const emittedTopics = hooksEmitMock.mock.calls.map((c) => c[0]);
    expect(emittedTopics).toContain('commentCreated');
    expect(emittedTopics).toContain('notificationRead');
  });

  it('returns ok:true with jobId:null when follow-up spawn is suppressed (e.g. disabled)', async () => {
    selectLimit
      .mockResolvedValueOnce([verifiedUser])
      .mockResolvedValueOnce([{ id: decisionId, eventRef: { issueIds: [] } }]);
    updateReturning.mockResolvedValueOnce([]);
    spawnMock.mockResolvedValueOnce({ ok: false, reason: 'disabled' });

    const token = await signUserToken('u-1');
    const app = buildApp();
    const r = await app.fetch(
      req(path, { method: 'POST', token, body: JSON.stringify({ choice: 'reject' }) }),
    );
    expect(r.status).toBe(200);
    const json = (await r.json()) as { ok: boolean; jobId: null; reason: string };
    expect(json).toEqual({ ok: true, jobId: null, reason: 'disabled' });
  });

  it('skips comment insert when issue belongs to a different project', async () => {
    selectLimit
      .mockResolvedValueOnce([verifiedUser])
      .mockResolvedValueOnce([{ id: decisionId, eventRef: { issueIds: [issueId] } }])
      .mockResolvedValueOnce([{ id: issueId, projectId: 'other-project' }]);
    updateReturning.mockResolvedValueOnce([]);
    spawnMock.mockResolvedValueOnce({ ok: true, jobId: 'pm-2' });

    const token = await signUserToken('u-1');
    const app = buildApp();
    const r = await app.fetch(
      req(path, { method: 'POST', token, body: JSON.stringify({ choice: 'approve' }) }),
    );
    expect(r.status).toBe(200);
    expect(insertValues).not.toHaveBeenCalled();
  });
});
