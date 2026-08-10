import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_SECRET = 'test-secret-at-least-32-chars-long-abcdef';
const APP_BASE_URL = 'https://app.example.com';

// === Module mocks ===

vi.mock('../../config/env.js', () => ({
  env: {
    NODE_ENV: 'test',
    APP_BASE_URL,
    JWT_SECRET: TEST_SECRET,
  },
}));

const isEnabled = vi.fn();
vi.mock('../../lib/feature-flags.js', () => ({
  isEnabled,
}));

const insertReturning = vi.fn();
const updateReturning = vi.fn();
const selectLimit = vi.fn();

vi.mock('../../db/client.js', () => ({
  db: {
    insert: vi.fn(() => ({
      values: vi.fn(() => ({
        onConflictDoNothing: vi.fn(() => ({ returning: insertReturning })),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => ({ returning: updateReturning })),
      })),
    })),
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({ limit: selectLimit })),
      })),
    })),
  },
}));

vi.mock('../../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const { __resetRateLimitStore } = await import('../../middleware/rate-limit.js');
const { pairingRoutes } = await import('./pairing-routes.js');
const { errorHandler } = await import('../../middleware/error.js');
const { requestId } = await import('../../middleware/request-id.js');
const { signUserToken } = await import('../jwt.js');

function buildApp() {
  const app = new Hono<{ Variables: import('../../middleware/request-id.js').RequestIdVars }>();
  app.use('*', requestId());
  app.route('/api/auth', pairingRoutes);
  app.onError(errorHandler);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  isEnabled.mockReturnValue(true);
  insertReturning.mockReset();
  updateReturning.mockReset();
  selectLimit.mockReset();
  __resetRateLimitStore();
});

const PAIR_INIT_BODY = {
  device_label: 'laptop · Forge Beta',
  device_platform: 'linux',
  device_hostname: 'forge-host',
};

function postPairInit(body: unknown = PAIR_INIT_BODY, ip = '10.0.0.1') {
  return buildApp().request('/api/auth/desktop/pair-init', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function postApprove(body: unknown, bearer: string, ip = '10.0.0.2') {
  return buildApp().request('/api/auth/desktop/approve', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: bearer,
      'x-forwarded-for': ip,
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function getPoll(code: string) {
  return buildApp().request(
    `/api/auth/desktop/poll?pairing_code=${encodeURIComponent(code)}`,
  );
}

// =====================================================================
// POST /desktop/pair-init
// =====================================================================

describe('POST /api/auth/desktop/pair-init', () => {
  it('returns 404 when desktopPairing flag is off', async () => {
    isEnabled.mockReturnValue(false);
    insertReturning.mockResolvedValueOnce([{ id: 'unused' }]);
    const res = await postPairInit();
    expect(res.status).toBe(404);
  });

  it('returns 400 when device_label is missing', async () => {
    const res = await postPairInit({ device_platform: 'linux' });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('INVALID_BODY');
  });

  it('returns 400 when device_platform is not in the allow-list', async () => {
    const res = await postPairInit({
      device_label: 'laptop',
      device_platform: 'bsd',
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('INVALID_BODY');
  });

  it('happy path returns a formatted XXX-XXXX code with ISO expiry', async () => {
    insertReturning.mockResolvedValueOnce([{ id: 'row-1' }]);
    const res = await postPairInit();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { pairing_code: string; expires_at: string };
    expect(body.pairing_code).toMatch(/^[0-9A-HJKMNPQRSTVWXYZ]{3}-[0-9A-HJKMNPQRSTVWXYZ]{4}$/);
    expect(new Date(body.expires_at).getTime()).toBeGreaterThan(Date.now());
  });

  it('returns 500 CODE_GENERATION_FAILED if every insert collides', async () => {
    insertReturning.mockResolvedValue([]); // every attempt collides
    const res = await postPairInit();
    expect(res.status).toBe(500);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('CODE_GENERATION_FAILED');
  });

  it('rate-limits at 20/hour from the same IP', async () => {
    insertReturning.mockResolvedValue([{ id: 'row' }]);
    let last = 200;
    for (let i = 0; i < 21; i++) {
      const res = await postPairInit(PAIR_INIT_BODY, '10.0.0.50');
      last = res.status;
    }
    expect(last).toBe(429);
  });
});

// =====================================================================
// POST /desktop/approve
// =====================================================================

describe('POST /api/auth/desktop/approve', () => {
  const userId = 'b8a2c1c2-3a44-4d6c-9b0e-000000000001';
  let bearer = '';

  beforeEach(async () => {
    bearer = `Bearer ${await signUserToken(userId)}`;
  });

  it('returns 401 without auth', async () => {
    const res = await buildApp().request('/api/auth/desktop/approve', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pairing_code: 'ABC-DEFG' }),
    });
    expect(res.status).toBe(401);
  });

  it('returns 400 INVALID_PAIRING_CODE for a non-Crockford code', async () => {
    const res = await postApprove({ pairing_code: 'abc-defi' }, bearer); // 'I' excluded
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('INVALID_PAIRING_CODE');
  });

  it('returns 400 INVALID_PAIRING_CODE for the wrong length', async () => {
    const res = await postApprove({ pairing_code: 'AB-CDEF' }, bearer);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('INVALID_PAIRING_CODE');
  });

  it('returns 404 PAIRING_CODE_NOT_FOUND on any miss (unknown / used / expired)', async () => {
    updateReturning.mockResolvedValueOnce([]);
    const res = await postApprove({ pairing_code: 'ABC-DEFG' }, bearer);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('PAIRING_CODE_NOT_FOUND');
  });

  it('happy path returns 200 with device fingerprint fields', async () => {
    const createdAt = new Date('2026-05-24T07:00:00Z');
    const expiresAt = new Date(Date.now() + 5 * 60_000);
    updateReturning.mockResolvedValueOnce([
      {
        id: 'row-2',
        deviceLabel: 'laptop',
        devicePlatform: 'linux',
        deviceHostname: 'forge-host',
        createdIp: '10.0.0.1',
        createdUserAgent: 'Forge/0.2.1',
        createdAt,
        expiresAt,
      },
    ]);
    const res = await postApprove({ pairing_code: 'ABC-DEFG' }, bearer);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      approved: boolean;
      device: { hostname: string; platform: string };
    };
    expect(body.approved).toBe(true);
    expect(body.device.platform).toBe('linux');
    expect(body.device.hostname).toBe('forge-host');
  });

  it('rate-limits at 10/hour/IP (counts misses too — no oracle)', async () => {
    updateReturning.mockResolvedValue([]);
    let last = 404;
    for (let i = 0; i < 11; i++) {
      const res = await postApprove({ pairing_code: 'ABC-DEFG' }, bearer, '10.0.0.99');
      last = res.status;
    }
    expect(last).toBe(429);
  });
});

// =====================================================================
// GET /desktop/poll
// =====================================================================

describe('GET /api/auth/desktop/poll', () => {
  it('returns 400 when pairing_code query is missing', async () => {
    const res = await buildApp().request('/api/auth/desktop/poll');
    expect(res.status).toBe(400);
  });

  it('returns 204 when the row is still pending (not yet approved)', async () => {
    updateReturning.mockResolvedValueOnce([]); // no row qualifies for consumption
    selectLimit.mockResolvedValueOnce([
      {
        approvedUserId: null,
        consumedAt: null,
        expiresAt: new Date(Date.now() + 5 * 60_000),
      },
    ]);
    const res = await getPoll('ABC-DEFG');
    expect(res.status).toBe(204);
  });

  it('returns 410 PAIRING_CODE_GONE when the code is unknown', async () => {
    updateReturning.mockResolvedValueOnce([]);
    selectLimit.mockResolvedValueOnce([]);
    const res = await getPoll('ABC-DEFG');
    expect(res.status).toBe(410);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('PAIRING_CODE_GONE');
  });

  it('returns 410 PAIRING_CODE_EXPIRED when expires_at is in the past', async () => {
    updateReturning.mockResolvedValueOnce([]);
    selectLimit.mockResolvedValueOnce([
      {
        approvedUserId: null,
        consumedAt: null,
        expiresAt: new Date(Date.now() - 1000),
      },
    ]);
    const res = await getPoll('ABC-DEFG');
    expect(res.status).toBe(410);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('PAIRING_CODE_EXPIRED');
  });

  it('returns 410 PAIRING_CODE_CONSUMED for an already-consumed code', async () => {
    updateReturning.mockResolvedValueOnce([]);
    selectLimit.mockResolvedValueOnce([
      {
        approvedUserId: 'u1',
        consumedAt: new Date(Date.now() - 60_000),
        expiresAt: new Date(Date.now() + 5 * 60_000),
      },
    ]);
    const res = await getPoll('ABC-DEFG');
    expect(res.status).toBe(410);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('PAIRING_CODE_CONSUMED');
  });

  it('happy path — atomic single-use consumes the row and returns token + user', async () => {
    const userId = 'b8a2c1c2-3a44-4d6c-9b0e-000000000003';
    updateReturning.mockResolvedValueOnce([{ id: 'row-3', approvedUserId: userId }]);
    selectLimit.mockResolvedValueOnce([{ id: userId, email: 'desk@example.com' }]);
    const res = await getPoll('ABC-DEFG');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string; user: { id: string; email: string } };
    expect(body.user).toEqual({ id: userId, email: 'desk@example.com' });
    expect(body.token.split('.').length).toBe(3);
  });
});
