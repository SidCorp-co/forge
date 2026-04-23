import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DeviceVars } from './require-device.js';

vi.mock('../auth/deviceToken.js', () => ({
  verifyDeviceToken: vi.fn(),
}));

const { errorHandler } = await import('./error.js');
const { requireDevice } = await import('./require-device.js');
const { verifyDeviceToken } = await import('../auth/deviceToken.js');

type DeviceRow = {
  id: string;
  ownerId: string;
  name: string;
  platform: 'macos' | 'linux' | 'windows';
  tokenHash: string | null;
  tokenPrefix: string | null;
  status: 'online' | 'offline' | 'revoked';
  createdAt: Date;
};

const testDevice: DeviceRow = {
  id: 'dev-1',
  ownerId: 'user-1',
  name: 'macbook',
  platform: 'macos',
  tokenHash: 'hash',
  tokenPrefix: 'abcd1234',
  status: 'online',
  createdAt: new Date('2026-01-01T00:00:00Z'),
};

function makeApp() {
  const app = new Hono<{ Variables: DeviceVars & { user?: unknown } }>();
  app.use('*', requireDevice());
  app.get('/me', (c) => c.json(c.get('device')));
  app.get('/principals', (c) =>
    c.json({ device: c.get('device'), user: c.get('user') ?? null }),
  );
  app.onError(errorHandler as unknown as Parameters<typeof app.onError>[0]);
  return app;
}

beforeEach(() => {
  vi.mocked(verifyDeviceToken).mockReset();
});

describe('requireDevice middleware', () => {
  it('authenticates via Authorization: Bearer <token> and attaches device', async () => {
    vi.mocked(verifyDeviceToken).mockResolvedValue(testDevice as unknown as never);
    const app = makeApp();
    const res = await app.request('/me', {
      headers: { authorization: 'Bearer abcd1234xxxxxxxxxxxxxxxxxxxxxxxxxxxx' },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as DeviceRow;
    expect(body.id).toBe(testDevice.id);
    expect(vi.mocked(verifyDeviceToken)).toHaveBeenCalledWith(
      'abcd1234xxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    );
  });

  it('returns 401 UNAUTHENTICATED when no Authorization header is provided', async () => {
    const app = makeApp();
    const res = await app.request('/me');
    expect(res.status).toBe(401);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('UNAUTHENTICATED');
    expect(vi.mocked(verifyDeviceToken)).not.toHaveBeenCalled();
  });

  it('returns 401 UNAUTHENTICATED for a non-Bearer scheme', async () => {
    const app = makeApp();
    const res = await app.request('/me', {
      headers: { authorization: 'Basic abc123' },
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('UNAUTHENTICATED');
    expect(vi.mocked(verifyDeviceToken)).not.toHaveBeenCalled();
  });

  it('returns 401 UNAUTHENTICATED for an empty Bearer token', async () => {
    const app = makeApp();
    const res = await app.request('/me', {
      headers: { authorization: 'Bearer    ' },
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('UNAUTHENTICATED');
    expect(vi.mocked(verifyDeviceToken)).not.toHaveBeenCalled();
  });

  it('returns 401 UNAUTHENTICATED when verifyDeviceToken resolves null (invalid token)', async () => {
    vi.mocked(verifyDeviceToken).mockResolvedValue(null);
    const app = makeApp();
    const res = await app.request('/me', {
      headers: { authorization: 'Bearer not-a-real-device-token' },
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('UNAUTHENTICATED');
  });

  it('returns 401 UNAUTHENTICATED when verifyDeviceToken resolves null for a revoked device', async () => {
    // verifyDeviceToken internally skips revoked rows and returns null.
    vi.mocked(verifyDeviceToken).mockResolvedValue(null);
    const app = makeApp();
    const res = await app.request('/me', {
      headers: { authorization: 'Bearer revoked-token-value' },
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('UNAUTHENTICATED');
  });

  it('does NOT populate c.get("user") — distinct principals', async () => {
    vi.mocked(verifyDeviceToken).mockResolvedValue(testDevice as unknown as never);
    const app = makeApp();
    const res = await app.request('/principals', {
      headers: { authorization: 'Bearer abcd1234xxxxxxxxxxxxxxxxxxxx' },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { device: DeviceRow; user: unknown };
    expect(body.device.id).toBe(testDevice.id);
    expect(body.user).toBeNull();
  });

  it('ignores forge_auth cookie — device auth is header-only', async () => {
    const app = makeApp();
    const res = await app.request('/me', {
      headers: { cookie: 'forge_auth=some-user-jwt-value' },
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('UNAUTHENTICATED');
    expect(vi.mocked(verifyDeviceToken)).not.toHaveBeenCalled();
  });
});
