// The four runner-binding suites of `routes.test.ts`, split out so that file
// stops growing against its frozen size budget. Same mock shape: verified-email
// lookup is the first select every authenticated request makes (queued FIFO via
// `selectLimit`), authz resolvers are stubbed, the pure role helpers stay real.

import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_SECRET = 'test-secret-at-least-32-chars-long-abcdef';

vi.mock('../config/env.js', () => ({
  env: { JWT_SECRET: TEST_SECRET, NODE_ENV: 'test' },
}));

const selectLimit = vi.fn();
const selectWhere = vi.fn((): unknown => ({ limit: selectLimit }));
const selectOn = vi.fn(() => ({ where: selectWhere }));
const innerJoin = vi.fn(() => ({ on: selectOn, where: selectWhere }));
const selectFrom = vi.fn(() => ({
  where: selectWhere,
  innerJoin,
  leftJoin: innerJoin,
  limit: selectLimit,
}));

const updateReturning = vi.fn();
const updateWhere = vi.fn(() => ({ returning: updateReturning }));
const updateSet = vi.fn((..._args: unknown[]) => ({ where: updateWhere }));
const dbUpdate = vi.fn(() => ({ set: updateSet }));

const deleteWhere = vi.fn(async () => undefined);
const dbDelete = vi.fn(() => ({ where: deleteWhere }));

const insertOnConflict = vi.fn(async () => undefined);
const insertReturning = vi.fn();
const insertOnConflictDoUpdate = vi.fn(() => ({ returning: insertReturning }));
const insertValues = vi.fn((..._args: unknown[]) => ({
  onConflictDoNothing: insertOnConflict,
  onConflictDoUpdate: insertOnConflictDoUpdate,
  returning: insertReturning,
}));
const dbInsert = vi.fn(() => ({ values: insertValues }));

vi.mock('../db/client.js', () => ({
  db: {
    select: vi.fn(() => ({ from: selectFrom })),
    update: dbUpdate,
    delete: dbDelete,
    insert: dbInsert,
  },
}));

const projectAccess = vi.fn();
vi.mock('../lib/authz.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/authz.js')>()),
  loadProjectAccess: (...args: unknown[]) => projectAccess(...args),
}));

const { projectRoutes } = await import('./routes.js');
const { signUserToken } = await import('../auth/jwt.js');
const { errorHandler } = await import('../middleware/error.js');
const { requestId } = await import('../middleware/request-id.js');

function buildApp() {
  const app = new Hono<{ Variables: import('../middleware/request-id.js').RequestIdVars }>();
  app.use('*', requestId());
  app.route('/api/projects', projectRoutes);
  app.onError(errorHandler);
  return app;
}

const ORG_ID = '99999999-9999-4999-8999-999999999999';

type Role = 'admin' | 'member' | 'viewer' | null;
type OrgRole = 'owner' | 'admin' | 'member' | null;
const access = (role: Role, orgRole: OrgRole = null) => ({
  projectId: 'p1',
  orgId: ORG_ID,
  role,
  orgRole,
});

beforeEach(() => {
  vi.clearAllMocks();
  selectLimit.mockReset();
  updateReturning.mockReset();
  insertReturning.mockReset();
  projectAccess.mockReset();
});

function req(path: string, init: RequestInit & { token?: string } = {}) {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...((init.headers as Record<string, string>) ?? {}),
  };
  if (init.token) headers.authorization = `Bearer ${init.token}`;
  const { token: _t, ...rest } = init;
  return buildApp().request(`/api/projects${path}`, { ...rest, headers });
}

describe('POST /api/projects/:id/runners (ISS-172)', () => {
  const PID = '11111111-1111-4111-8111-111111111111';
  const DID = '22222222-2222-4222-8222-222222222222';
  const RID = '33333333-3333-4333-8333-333333333333';

  it('403 FORBIDDEN for non-admin member', async () => {
    const token = await signUserToken('uuid-member');
    selectLimit.mockResolvedValueOnce([{ emailVerifiedAt: new Date() }]);
    projectAccess.mockResolvedValueOnce(access('member'));

    const res = await req(`/${PID}/runners`, {
      method: 'POST',
      body: JSON.stringify({ deviceId: DID }),
      token,
    });
    expect(res.status).toBe(403);
    expect(insertValues).not.toHaveBeenCalled();
  });

  it('404 DEVICE_NOT_FOUND when deviceId does not exist', async () => {
    const token = await signUserToken('uuid-owner');
    projectAccess.mockResolvedValueOnce(access('admin', 'owner'));
    selectLimit.mockResolvedValueOnce([{ emailVerifiedAt: new Date() }]).mockResolvedValueOnce([]);

    const res = await req(`/${PID}/runners`, {
      method: 'POST',
      body: JSON.stringify({ deviceId: DID }),
      token,
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('DEVICE_NOT_FOUND');
    expect(insertValues).not.toHaveBeenCalled();
  });

  it('201 upserts a claude-code runner row (idempotent, status=online when device fresh)', async () => {
    const token = await signUserToken('uuid-owner');
    const lastSeenAt = new Date();
    projectAccess.mockResolvedValueOnce(access('admin', 'owner'));
    selectLimit
      .mockResolvedValueOnce([{ emailVerifiedAt: new Date() }])
      .mockResolvedValueOnce([{ id: DID, name: 'laptop', status: 'online', lastSeenAt }]);
    insertReturning.mockResolvedValueOnce([
      { id: RID, projectId: PID, deviceId: DID, status: 'online' },
    ]);

    const res = await req(`/${PID}/runners`, {
      method: 'POST',
      body: JSON.stringify({ deviceId: DID }),
      token,
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; status: string };
    expect(body.id).toBe(RID);
    expect(body.status).toBe('online');
    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: PID,
        deviceId: DID,
        type: 'claude-code',
        host: 'device',
        status: 'online',
      }),
    );
    expect(insertOnConflictDoUpdate).toHaveBeenCalled();
  });

  it('201 with status=offline when device.status is offline', async () => {
    const token = await signUserToken('uuid-owner');
    projectAccess.mockResolvedValueOnce(access('admin', 'owner'));
    selectLimit
      .mockResolvedValueOnce([{ emailVerifiedAt: new Date() }])
      .mockResolvedValueOnce([{ id: DID, name: 'laptop', status: 'offline', lastSeenAt: null }]);
    insertReturning.mockResolvedValueOnce([
      { id: RID, projectId: PID, deviceId: DID, status: 'offline' },
    ]);

    const res = await req(`/${PID}/runners`, {
      method: 'POST',
      body: JSON.stringify({ deviceId: DID }),
      token,
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe('offline');
    expect(insertValues).toHaveBeenCalledWith(expect.objectContaining({ status: 'offline' }));
  });

  it('400 BAD_REQUEST when deviceId is not a uuid', async () => {
    const token = await signUserToken('uuid-owner');
    selectLimit.mockResolvedValueOnce([{ emailVerifiedAt: new Date() }]);

    const res = await req(`/${PID}/runners`, {
      method: 'POST',
      body: JSON.stringify({ deviceId: 'not-a-uuid' }),
      token,
    });
    expect(res.status).toBe(400);
  });
});

describe('DELETE /api/projects/:id/runners/:runnerId (ISS-172)', () => {
  const PID = '11111111-1111-4111-8111-111111111111';
  const RID = '33333333-3333-4333-8333-333333333333';

  it('403 FORBIDDEN for non-admin member', async () => {
    const token = await signUserToken('uuid-member');
    selectLimit.mockResolvedValueOnce([{ emailVerifiedAt: new Date() }]);
    projectAccess.mockResolvedValueOnce(access('member'));

    const res = await req(`/${PID}/runners/${RID}`, { method: 'DELETE', token });
    expect(res.status).toBe(403);
    expect(deleteWhere).not.toHaveBeenCalled();
  });

  it('204 removes the runner row for project admin', async () => {
    const token = await signUserToken('uuid-owner');
    selectLimit.mockResolvedValueOnce([{ emailVerifiedAt: new Date() }]);
    projectAccess.mockResolvedValueOnce(access('admin', 'owner'));

    const res = await req(`/${PID}/runners/${RID}`, { method: 'DELETE', token });
    expect(res.status).toBe(204);
    expect(deleteWhere).toHaveBeenCalled();
  });
});

describe('POST /api/projects/:id/runners — repoPath/branch (ISS-271)', () => {
  const PID = '11111111-1111-4111-8111-111111111111';
  const DID = '22222222-2222-4222-8222-222222222222';
  const RID = '33333333-3333-4333-8333-333333333333';

  it('passes repoPath/branch into the insert and returns them', async () => {
    const token = await signUserToken('uuid-owner');
    projectAccess.mockResolvedValueOnce(access('admin', 'owner'));
    selectLimit
      .mockResolvedValueOnce([{ emailVerifiedAt: new Date() }])
      .mockResolvedValueOnce([
        { id: DID, name: 'laptop', status: 'online', lastSeenAt: new Date() },
      ]);
    insertReturning.mockResolvedValueOnce([
      {
        id: RID,
        projectId: PID,
        deviceId: DID,
        repoPath: '/home/u/code/app',
        branch: 'main',
        status: 'online',
      },
    ]);

    const res = await req(`/${PID}/runners`, {
      method: 'POST',
      body: JSON.stringify({ deviceId: DID, repoPath: '/home/u/code/app', branch: 'main' }),
      token,
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { repoPath: string; branch: string };
    expect(body.repoPath).toBe('/home/u/code/app');
    expect(body.branch).toBe('main');
    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({ repoPath: '/home/u/code/app', branch: 'main' }),
    );
  });
});

describe('PATCH /api/projects/:id/runners/:runnerId (ISS-271)', () => {
  const PID = '11111111-1111-4111-8111-111111111111';
  const RID = '33333333-3333-4333-8333-333333333333';

  it('403 FORBIDDEN for non-admin member', async () => {
    const token = await signUserToken('uuid-member');
    selectLimit.mockResolvedValueOnce([{ emailVerifiedAt: new Date() }]);
    projectAccess.mockResolvedValueOnce(access('member'));

    const res = await req(`/${PID}/runners/${RID}`, {
      method: 'PATCH',
      body: JSON.stringify({ repoPath: '/x' }),
      token,
    });
    expect(res.status).toBe(403);
    expect(updateReturning).not.toHaveBeenCalled();
  });

  it('200 updates repoPath/branch for project admin', async () => {
    const token = await signUserToken('uuid-owner');
    selectLimit.mockResolvedValueOnce([{ emailVerifiedAt: new Date() }]);
    projectAccess.mockResolvedValueOnce(access('admin', 'owner'));
    updateReturning.mockResolvedValueOnce([
      {
        id: RID,
        projectId: PID,
        deviceId: '22222222-2222-4222-8222-222222222222',
        repoPath: '/home/u/code/app',
        branch: 'dev',
        status: 'online',
      },
    ]);

    const res = await req(`/${PID}/runners/${RID}`, {
      method: 'PATCH',
      body: JSON.stringify({ repoPath: '/home/u/code/app', branch: 'dev' }),
      token,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { repoPath: string; branch: string };
    expect(body.repoPath).toBe('/home/u/code/app');
    expect(body.branch).toBe('dev');
    expect(updateSet).toHaveBeenCalledWith(
      expect.objectContaining({ repoPath: '/home/u/code/app', branch: 'dev' }),
    );
  });

  // cm:guard `labels` is what `releaseRunnerLabel` matches against, and this route is the only PAT-reachable writer of it — drop it and a gated project's release pool can be declared by nobody (2026-09-03: sidpeak sat at RELEASE_POOL_EMPTY with three online runners because the fleet route is fenced from PATs and no UI writes the column)
  it('200 replaces labels for project admin', async () => {
    const token = await signUserToken('uuid-owner');
    selectLimit.mockResolvedValueOnce([{ emailVerifiedAt: new Date() }]);
    projectAccess.mockResolvedValueOnce(access('admin', 'owner'));
    updateReturning.mockResolvedValueOnce([
      {
        id: RID,
        projectId: PID,
        deviceId: null,
        repoPath: null,
        branch: null,
        labels: ['release'],
        status: 'online',
      },
    ]);

    const res = await req(`/${PID}/runners/${RID}`, {
      method: 'PATCH',
      body: JSON.stringify({ labels: ['release'] }),
      token,
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { labels: string[] }).labels).toEqual(['release']);
    expect(updateSet).toHaveBeenCalledWith(expect.objectContaining({ labels: ['release'] }));
    expect(updateSet).toHaveBeenCalledWith(
      expect.not.objectContaining({ repoPath: expect.anything() }),
    );
  });

  it('400 on an empty label', async () => {
    const token = await signUserToken('uuid-owner');
    selectLimit.mockResolvedValueOnce([{ emailVerifiedAt: new Date() }]);

    const res = await req(`/${PID}/runners/${RID}`, {
      method: 'PATCH',
      body: JSON.stringify({ labels: [''] }),
      token,
    });
    expect(res.status).toBe(400);
    expect(updateReturning).not.toHaveBeenCalled();
  });

  it('404 RUNNER_NOT_FOUND when no row matches', async () => {
    const token = await signUserToken('uuid-owner');
    selectLimit.mockResolvedValueOnce([{ emailVerifiedAt: new Date() }]);
    projectAccess.mockResolvedValueOnce(access('admin', 'owner'));
    updateReturning.mockResolvedValueOnce([]);

    const res = await req(`/${PID}/runners/${RID}`, {
      method: 'PATCH',
      body: JSON.stringify({ repoPath: '/home/u/code/app' }),
      token,
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('RUNNER_NOT_FOUND');
  });

  it('400 BAD_REQUEST on unknown field (strict body)', async () => {
    const token = await signUserToken('uuid-owner');
    selectLimit.mockResolvedValueOnce([{ emailVerifiedAt: new Date() }]);

    const res = await req(`/${PID}/runners/${RID}`, {
      method: 'PATCH',
      body: JSON.stringify({ nope: true }),
      token,
    });
    expect(res.status).toBe(400);
  });
});
