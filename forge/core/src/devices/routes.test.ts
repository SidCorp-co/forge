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

const updateReturning = vi.fn(async () => [{ id: 'dev-1' }]);
const updateWhere = vi.fn(() => ({ returning: updateReturning }));
const updateSet = vi.fn(() => ({ where: updateWhere }));
const dbUpdate = vi.fn(() => ({ set: updateSet }));

vi.mock('../db/client.js', () => ({
  db: { insert: dbInsert, update: dbUpdate },
}));

// Bypass auth for user-route tests via loadProjectAccess mock + assertEmailVerified noop.
const loadProjectAccess = vi.fn(async () => ({
  projectId: 'proj-1',
  ownerId: 'u-1',
  role: 'owner',
}));
vi.mock('../lib/project-access.js', () => ({
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
    const body = await res.json();
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
    const body = await res.json();
    expect(typeof body.code).toBe('string');
    expect(body.code).toMatch(/^[A-Z0-9]{2}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    expect(typeof body.expiresAt).toBe('string');
    expect(insertValues).toHaveBeenCalledOnce();
  });

  it('returns 403 for non-members', async () => {
    loadProjectAccess.mockResolvedValueOnce({
      projectId: 'proj-1',
      ownerId: 'someone-else',
      role: null,
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
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(typeof body.serverTime).toBe('string');
    expect(updateSet).toHaveBeenCalled();
  });
});
