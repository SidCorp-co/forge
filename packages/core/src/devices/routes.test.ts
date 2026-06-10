import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_PEPPER = 'y'.repeat(32);

vi.mock('../config/env.js', () => ({
  env: {
    DEVICE_TOKEN_PEPPER: TEST_PEPPER,
    NODE_ENV: 'test',
    RATE_LIMIT_DEVICES_PAIR_MAX: 100,
    RATE_LIMIT_DEVICES_PAIR_WINDOW_MS: 60_000,
  },
}));

// Redeem mock drives the /pair route outcomes.
const redeemPairingCode = vi.fn();
vi.mock('./pair.js', () => ({
  redeemPairingCode: (i: unknown) => redeemPairingCode(i),
}));

const verifyDeviceToken = vi.fn(async (token: string) => {
  if (token === 'good') {
    return { id: 'dev-1', ownerId: 'u-1', status: 'offline', name: 'laptop', platform: 'linux' };
  }
  return null;
});
vi.mock('../auth/deviceToken.js', () => ({
  verifyDeviceToken: (t: string) => verifyDeviceToken(t),
}));

const insertValues = vi.fn(async () => []);
const dbInsert = vi.fn(() => ({ values: insertValues }));

const updateReturning = vi.fn(async (): Promise<Record<string, unknown>[]> => [{ id: 'dev-1' }]);
const updateWhere = vi.fn(() => ({ returning: updateReturning, then: undefined }));
const updateSet = vi.fn(() => ({ where: updateWhere }));
const dbUpdate = vi.fn(() => ({ set: updateSet }));

const selectLimit = vi.fn();
const selectOrderBy = vi.fn();
const selectWhere = vi.fn((): unknown => ({ limit: selectLimit, orderBy: selectOrderBy }));
const selectInnerJoin = vi.fn(() => ({ where: selectWhere }));
const selectFrom = vi.fn(() => ({ where: selectWhere, innerJoin: selectInnerJoin }));
const dbSelect = vi.fn(() => ({ from: selectFrom }));

const deleteWhere = vi.fn(async () => undefined);
const dbDelete = vi.fn(() => ({ where: deleteWhere }));

const txUpdateWhere = vi.fn(async () => undefined);
const txUpdateSet = vi.fn(() => ({ where: txUpdateWhere }));
const txUpdate = vi.fn(() => ({ set: txUpdateSet }));
const txDeleteWhere = vi.fn(async () => undefined);
const txDelete = vi.fn(() => ({ where: txDeleteWhere }));
const dbTransaction = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
  fn({ update: txUpdate, delete: txDelete }),
);

// ISS-381 (2.3) — the heartbeat now mirrors runner status via a change-gated
// CTE `db.execute`; default to no transitions (empty result).
const dbExecute = vi.fn(async () => [] as Array<Record<string, unknown>>);

vi.mock('../db/client.js', () => ({
  db: {
    insert: dbInsert,
    update: dbUpdate,
    select: dbSelect,
    delete: dbDelete,
    transaction: dbTransaction,
    execute: dbExecute,
  },
}));

// Bypass auth for user-route tests via loadProjectAccess mock + assertEmailVerified noop.
type MockAccess = {
  projectId: string;
  orgId: string;
  role: 'admin' | 'member' | 'viewer' | null;
  orgRole: 'owner' | 'admin' | 'member' | null;
};
const loadProjectAccess = vi.fn(
  async (..._args: unknown[]): Promise<MockAccess> => ({
    projectId: 'proj-1',
    orgId: 'org-1',
    role: 'admin',
    orgRole: 'owner',
  }),
);
vi.mock('../lib/authz.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/authz.js')>()),
  loadProjectAccess: (a: string, b: string) => loadProjectAccess(a, b),
}));

vi.mock('../middleware/auth.js', () => ({
  requireAuth: () => async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
    c.set('userId', 'u-1');
    await next();
  },
  assertEmailVerified: () => async (_c: unknown, next: () => Promise<void>) => {
    await next();
  },
}));

// Per-test override for the fresh-auth gate. Default: passthrough so the
// existing happy-path assertions don't have to seed a stamp. The DELETE-gate
// test below flips this to assert a stale stamp returns 403.
const freshAuthHandler = vi.fn(async (_c: unknown, next: () => Promise<void>) => {
  await next();
});
vi.mock('../middleware/require-fresh-auth.js', () => ({
  requireFreshAuth: () => (c: unknown, next: () => Promise<void>) => freshAuthHandler(c, next),
}));

const publishMock = vi.fn(() => 0);
vi.mock('../ws/server.js', () => ({
  roomManager: { publish: publishMock },
}));

const routes = await import('./routes.js');
const { errorHandler } = await import('../middleware/error.js');
const { requestId } = await import('../middleware/request-id.js');
const { __resetRateLimitStore } = await import('../middleware/rate-limit.js');

function buildApp() {
  const app = new Hono<{ Variables: import('../middleware/request-id.js').RequestIdVars }>();
  app.use('*', requestId());
  app.route('/api/devices', routes.devicePublicRoutes);
  app.route('/api/devices', routes.deviceAuthRoutes);
  app.route('/api', routes.deviceOwnerRoutes);
  app.route('/api/projects', routes.deviceUserRoutes);
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

beforeEach(() => {
  __resetRateLimitStore();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('POST /api/devices/pair', () => {
  it('returns 201 with deviceId + token on success', async () => {
    redeemPairingCode.mockResolvedValueOnce({
      device: { id: 'dev-new' },
      plaintext: 'tok',
      projectId: 'proj-1',
    });
    const app = buildApp();
    const res = await app.fetch(
      req('/api/devices/pair', {
        method: 'POST',
        body: JSON.stringify({ code: 'AA-BBBB-CCCC', name: 'laptop', platform: 'linux' }),
      }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.deviceId).toBe('dev-new');
    expect(body.deviceToken).toBe('tok');
    expect(body.projectId).toBe('proj-1');
  });

  it('returns 400 for missing fields', async () => {
    const app = buildApp();
    const res = await app.fetch(
      req('/api/devices/pair', { method: 'POST', body: JSON.stringify({ code: 'AA-BB' }) }),
    );
    expect(res.status).toBe(400);
  });
});

describe('POST /api/projects/:id/devices/pairing-codes', () => {
  it('mints a code for project members', async () => {
    const app = buildApp();
    const res = await app.fetch(
      req('/api/projects/11111111-1111-4111-8111-111111111111/devices/pairing-codes', {
        method: 'POST',
        token: 'user-jwt',
        body: JSON.stringify({}),
      }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(typeof body.code).toBe('string');
    expect(body.code).toMatch(/^[A-Z0-9]{2}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    expect(typeof body.expiresAt).toBe('string');
    expect(insertValues).toHaveBeenCalledOnce();
  });

  it('returns 403 for non-members', async () => {
    loadProjectAccess.mockResolvedValueOnce({
      projectId: 'proj-1',
      orgId: 'org-1',
      role: null,
      orgRole: null,
    });
    const app = buildApp();
    const res = await app.fetch(
      req('/api/projects/11111111-1111-4111-8111-111111111111/devices/pairing-codes', {
        method: 'POST',
        token: 'user-jwt',
        body: JSON.stringify({}),
      }),
    );
    expect(res.status).toBe(403);
  });
});

describe('POST /api/devices/heartbeat', () => {
  it('returns 401 without device token', async () => {
    const app = buildApp();
    const res = await app.fetch(
      req('/api/devices/heartbeat', { method: 'POST', body: JSON.stringify({}) }),
    );
    expect(res.status).toBe(401);
  });

  it('returns 401 with invalid token', async () => {
    const app = buildApp();
    const res = await app.fetch(
      req('/api/devices/heartbeat', {
        method: 'POST',
        token: 'bad',
        body: JSON.stringify({}),
      }),
    );
    expect(res.status).toBe(401);
  });

  it('returns ok + serverTime on success', async () => {
    const app = buildApp();
    const res = await app.fetch(
      req('/api/devices/heartbeat', {
        method: 'POST',
        token: 'good',
        body: JSON.stringify({ agentVersion: '0.1.0' }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(typeof body.serverTime).toBe('string');
    expect(updateSet).toHaveBeenCalled();
  });
});

describe('GET /api/devices/me/runners (ISS-271)', () => {
  it('401 without a device token', async () => {
    const app = buildApp();
    const res = await app.fetch(req('/api/devices/me/runners'));
    expect(res.status).toBe(401);
  });

  it('401 with an invalid device token', async () => {
    const app = buildApp();
    const res = await app.fetch(req('/api/devices/me/runners', { token: 'bad' }));
    expect(res.status).toBe(401);
  });

  it('returns the calling device assignments with repoPath/branch/baseBranch/slug', async () => {
    selectWhere.mockReturnValueOnce(
      Promise.resolve([
        {
          projectId: 'proj-1',
          runnerId: 'run-1',
          slug: 'my-app',
          baseBranch: 'main',
          repoPath: '/home/u/code/my-app',
          branch: 'dev',
          status: 'online',
        },
      ]),
    );

    const app = buildApp();
    const res = await app.fetch(req('/api/devices/me/runners', { token: 'good' }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ slug: string; repoPath: string }>;
    expect(body).toHaveLength(1);
    expect(body[0]?.slug).toBe('my-app');
    expect(body[0]?.repoPath).toBe('/home/u/code/my-app');
    // Scoped to the authed device + claude-code runners.
    expect(selectInnerJoin).toHaveBeenCalled();
  });
});

describe('GET /api/devices/:id/runners (ISS-273)', () => {
  const ID = '11111111-1111-4111-8111-111111111111';

  it('400 on invalid uuid', async () => {
    const app = buildApp();
    const res = await app.fetch(req('/api/devices/not-a-uuid/runners', { token: 'user-jwt' }));
    expect(res.status).toBe(400);
  });

  it('404 when the device is missing', async () => {
    selectWhere.mockReturnValueOnce({ limit: vi.fn(async () => []) });
    const app = buildApp();
    const res = await app.fetch(req(`/api/devices/${ID}/runners`, { token: 'user-jwt' }));
    expect(res.status).toBe(404);
  });

  it('403 when the caller is not the device owner', async () => {
    selectWhere.mockReturnValueOnce({ limit: vi.fn(async () => [{ ownerId: 'someone-else' }]) });
    const app = buildApp();
    const res = await app.fetch(req(`/api/devices/${ID}/runners`, { token: 'user-jwt' }));
    expect(res.status).toBe(403);
  });

  it('returns the owned device assignments with repoPath/branch/status', async () => {
    selectWhere
      .mockReturnValueOnce({ limit: vi.fn(async () => [{ ownerId: 'u-1' }]) })
      .mockReturnValueOnce(
        Promise.resolve([
          {
            runnerId: 'run-1',
            projectId: 'proj-1',
            slug: 'my-app',
            name: 'My App',
            repoPath: '/home/u/code/my-app',
            branch: 'dev',
            status: 'online',
            lastSeenAt: new Date('2026-05-30T00:00:00Z'),
            projectDefaultRepoPath: '/srv/my-app',
            baseBranch: 'main',
          },
        ]),
      );

    const app = buildApp();
    const res = await app.fetch(req(`/api/devices/${ID}/runners`, { token: 'user-jwt' }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ slug: string; repoPath: string }>;
    expect(body).toHaveLength(1);
    expect(body[0]?.slug).toBe('my-app');
    expect(body[0]?.repoPath).toBe('/home/u/code/my-app');
    expect(selectInnerJoin).toHaveBeenCalled();
  });
});

describe('PATCH /api/devices/me/runners/:runnerId (ISS-271)', () => {
  const RID = '33333333-3333-4333-8333-333333333333';

  it('401 without a device token', async () => {
    const app = buildApp();
    const res = await app.fetch(
      req(`/api/devices/me/runners/${RID}`, {
        method: 'PATCH',
        body: JSON.stringify({ repoPath: '/x' }),
      }),
    );
    expect(res.status).toBe(401);
  });

  it('200 updates the calling device runner repoPath/branch', async () => {
    updateReturning.mockResolvedValueOnce([
      {
        id: RID,
        projectId: 'proj-1',
        deviceId: 'dev-1',
        repoPath: '/home/u/code/app',
        branch: 'main',
        status: 'online',
      },
    ]);

    const app = buildApp();
    const res = await app.fetch(
      req(`/api/devices/me/runners/${RID}`, {
        method: 'PATCH',
        token: 'good',
        body: JSON.stringify({ repoPath: '/home/u/code/app', branch: 'main' }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { repoPath: string; branch: string };
    expect(body.repoPath).toBe('/home/u/code/app');
    expect(body.branch).toBe('main');
    expect(updateSet).toHaveBeenCalledWith(
      expect.objectContaining({ repoPath: '/home/u/code/app', branch: 'main' }),
    );
  });

  it('404 RUNNER_NOT_FOUND when the runner is not this device', async () => {
    updateReturning.mockResolvedValueOnce([]);

    const app = buildApp();
    const res = await app.fetch(
      req(`/api/devices/me/runners/${RID}`, {
        method: 'PATCH',
        token: 'good',
        body: JSON.stringify({ repoPath: '/home/u/code/app' }),
      }),
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('RUNNER_NOT_FOUND');
  });
});

describe('GET /api/me/devices', () => {
  it('returns rows scoped to the current user', async () => {
    selectWhere.mockReturnValueOnce({
      orderBy: vi.fn(async () => [
        {
          id: 'dev-1',
          name: 'laptop',
          platform: 'linux',
          agentVersion: '0.1.0',
          status: 'online',
          lastSeenAt: new Date('2026-04-27T00:00:00Z'),
          pairedAt: new Date('2026-04-26T00:00:00Z'),
          capabilities: null,
          createdAt: new Date('2026-04-26T00:00:00Z'),
        },
      ]),
    });

    const app = buildApp();
    const res = await app.fetch(req('/api/me/devices', { token: 'user-jwt' }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ id: string }>;
    expect(body).toHaveLength(1);
    expect(body[0]?.id).toBe('dev-1');
  });
});

describe('PATCH /api/devices/:id', () => {
  const ID = '11111111-1111-4111-8111-111111111111';

  it('400 BAD_REQUEST on invalid uuid', async () => {
    const app = buildApp();
    const res = await app.fetch(
      req('/api/devices/not-a-uuid', {
        method: 'PATCH',
        token: 'user-jwt',
        body: JSON.stringify({ name: 'new' }),
      }),
    );
    expect(res.status).toBe(400);
  });

  it('404 NOT_FOUND when device missing', async () => {
    selectLimit.mockResolvedValueOnce([]);
    const app = buildApp();
    const res = await app.fetch(
      req(`/api/devices/${ID}`, {
        method: 'PATCH',
        token: 'user-jwt',
        body: JSON.stringify({ name: 'new' }),
      }),
    );
    expect(res.status).toBe(404);
  });

  it('403 FORBIDDEN when caller is not device owner', async () => {
    selectLimit.mockResolvedValueOnce([{ ownerId: 'someone-else' }]);
    const app = buildApp();
    const res = await app.fetch(
      req(`/api/devices/${ID}`, {
        method: 'PATCH',
        token: 'user-jwt',
        body: JSON.stringify({ name: 'new' }),
      }),
    );
    expect(res.status).toBe(403);
    expect(updateSet).not.toHaveBeenCalled();
  });

  it('200 renames the device when caller is owner', async () => {
    selectLimit.mockResolvedValueOnce([{ ownerId: 'u-1' }]);
    updateReturning.mockResolvedValueOnce([
      {
        id: ID,
        name: 'renamed',
        platform: 'linux',
        status: 'online',
        lastSeenAt: null,
        pairedAt: new Date(),
      },
    ]);

    const app = buildApp();
    const res = await app.fetch(
      req(`/api/devices/${ID}`, {
        method: 'PATCH',
        token: 'user-jwt',
        body: JSON.stringify({ name: 'renamed' }),
      }),
    );
    expect(res.status).toBe(200);
    expect(updateSet).toHaveBeenCalledWith({ name: 'renamed' });
  });
});

describe('DELETE /api/devices/:id (soft revoke + pool cleanup)', () => {
  const ID = '11111111-1111-4111-8111-111111111111';

  it('403 FORBIDDEN when caller is not device owner', async () => {
    selectLimit.mockResolvedValueOnce([{ ownerId: 'someone-else', status: 'online' }]);
    const app = buildApp();
    const res = await app.fetch(
      req(`/api/devices/${ID}`, { method: 'DELETE', token: 'user-jwt' }),
    );
    expect(res.status).toBe(403);
    expect(dbTransaction).not.toHaveBeenCalled();
  });

  it('204 sets status=revoked AND removes device from project pools', async () => {
    selectLimit.mockResolvedValueOnce([{ ownerId: 'u-1', status: 'online' }]);

    const app = buildApp();
    const res = await app.fetch(
      req(`/api/devices/${ID}`, { method: 'DELETE', token: 'user-jwt' }),
    );
    expect(res.status).toBe(204);
    expect(dbTransaction).toHaveBeenCalledOnce();
    expect(txUpdateSet).toHaveBeenCalledWith({ status: 'revoked' });
    expect(txDelete).toHaveBeenCalled();
  });

  it('404 NOT_FOUND when device missing', async () => {
    selectLimit.mockResolvedValueOnce([]);
    const app = buildApp();
    const res = await app.fetch(
      req(`/api/devices/${ID}`, { method: 'DELETE', token: 'user-jwt' }),
    );
    expect(res.status).toBe(404);
  });

  it('403 FRESH_AUTH_REQUIRED when fresh-auth gate rejects', async () => {
    const { HTTPException } = await import('hono/http-exception');
    freshAuthHandler.mockImplementationOnce(async () => {
      throw new HTTPException(403, {
        message: 'fresh authentication required',
        cause: { code: 'FRESH_AUTH_REQUIRED' },
      });
    });
    const app = buildApp();
    const res = await app.fetch(
      req(`/api/devices/${ID}`, { method: 'DELETE', token: 'user-jwt' }),
    );
    expect(res.status).toBe(403);
    expect(dbTransaction).not.toHaveBeenCalled();
  });
});
