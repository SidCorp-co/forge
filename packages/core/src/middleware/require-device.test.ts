/**
 * `requireDevice` unit tests (ISS-932).
 *
 * A box authenticates with an ordinary PAT/AAT carrying `device_id`. What is
 * proved here: the device is resolved from that column, a token WITHOUT one is
 * refused by name rather than accepted as its owner, a revoked box is refused
 * even when its token verifies, and no user principal is ever set.
 */
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DeviceVars } from './require-device.js';

vi.mock('../config/env.js', () => ({
  env: {
    NODE_ENV: 'test',
    PAT_PEPPER: 'pat-test-pepper',
    RATE_LIMIT_PAT_MAX: 600,
  },
}));
vi.mock('../auth/pat.js', () => ({ verifyPat: vi.fn(), touchPatUsage: vi.fn() }));
vi.mock('../auth/mcp-audit.js', () => ({ writeMcpAudit: vi.fn() }));
vi.mock('../ws/server.js', () => ({ roomManager: { publish: vi.fn() } }));

const selectLimit = vi.fn();
vi.mock('../db/client.js', () => ({
  db: {
    select: () => ({
      from: () => ({ where: () => ({ limit: (...a: unknown[]) => selectLimit(...a) }) }),
    }),
  },
}));

const { errorHandler } = await import('./error.js');
const { requireDevice } = await import('./require-device.js');
const { verifyPat } = await import('../auth/pat.js');

const PAT_TOKEN = `forge_pat_dev_${'a'.repeat(64)}`;
const DEVICE_ID = '00000000-0000-4000-8000-00000000d0d0';

const patRow = {
  id: '00000000-0000-4000-8000-0000000000aa',
  userId: 'holder-1',
  name: `device:${DEVICE_ID}`,
  tokenHash: '',
  tokenPrefix: PAT_TOKEN.slice(0, 18),
  scopes: ['read', 'write'],
  projectIds: null,
  boundProjectId: null,
  deviceId: DEVICE_ID,
  expiresAt: null,
  createdAt: new Date(0),
  lastUsedAt: null,
  lastUsedIp: null,
  revokedAt: null,
  rateLimitMax: null,
};

const deviceRow = {
  id: DEVICE_ID,
  ownerId: 'holder-1',
  name: 'macbook',
  platform: 'macos',
  status: 'online',
  createdAt: new Date('2026-01-01T00:00:00Z'),
};

function makeApp() {
  const app = new Hono<{ Variables: DeviceVars & { user?: unknown } }>();
  app.use('*', requireDevice());
  app.get('/me', (c) => c.json(c.get('device')));
  app.get('/principals', (c) => c.json({ device: c.get('device'), user: c.get('user') ?? null }));
  app.onError(errorHandler as unknown as Parameters<typeof app.onError>[0]);
  return app;
}

const bearer = (token: string) => ({ headers: { authorization: `Bearer ${token}` } });

beforeEach(() => {
  vi.mocked(verifyPat).mockReset();
  selectLimit.mockReset();
});

describe('requireDevice middleware', () => {
  it('resolves the device from the token`s device_id and attaches it', async () => {
    vi.mocked(verifyPat).mockResolvedValue({ row: patRow, ownerKind: 'human' } as never);
    selectLimit.mockResolvedValue([deviceRow]);

    const res = await makeApp().request('/me', bearer(PAT_TOKEN));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { id: string }).id).toBe(DEVICE_ID);
    expect(vi.mocked(verifyPat)).toHaveBeenCalledWith(PAT_TOKEN);
  });

  // cm:guard the assertion that carries wave 3 of ISS-932: a valid PAT with no `device_id` must be REFUSED, never accepted as its owner. Accepting it is the `device.ownerId` fiction returning — a person's whole account authority reachable from a box's routes — and a bare `toBe(401)` would not tell that apart from a token that simply failed to verify, which is why `verifyPat` is asserted to have succeeded first.
  it('refuses a valid PAT that carries no device, naming the class and the remedy', async () => {
    vi.mocked(verifyPat).mockResolvedValue({
      row: { ...patRow, name: 'my laptop', deviceId: null },
      ownerKind: 'human',
    } as never);

    const res = await makeApp().request('/me', bearer(PAT_TOKEN));
    expect(res.status).toBe(401);
    expect(vi.mocked(verifyPat)).toHaveBeenCalledOnce();
    expect(selectLimit).not.toHaveBeenCalled();
    const body = (await res.json()) as { code: string; message: string };
    expect(body.code).toBe('UNAUTHENTICATED');
    expect(body.message).toMatch(/carries no device/i);
    expect(body.message).toMatch(/forge login/i);
  });

  // cm:guard revoking a box and revoking its token are two writes, so this asserts the SECOND defence: a token that still verifies must not reach a revoked device. Deleting this check leaves an unpaired machine authenticated for as long as its token outlives the revoke.
  it('refuses a token whose device row is revoked, even though the token verifies', async () => {
    vi.mocked(verifyPat).mockResolvedValue({ row: patRow, ownerKind: 'human' } as never);
    selectLimit.mockResolvedValue([{ ...deviceRow, status: 'revoked' }]);

    const res = await makeApp().request('/me', bearer(PAT_TOKEN));
    expect(res.status).toBe(401);
    expect(((await res.json()) as { message: string }).message).toMatch(/carries no device/i);
  });

  it('refuses a token whose device row no longer exists', async () => {
    vi.mocked(verifyPat).mockResolvedValue({ row: patRow, ownerKind: 'human' } as never);
    selectLimit.mockResolvedValue([]);
    const res = await makeApp().request('/me', bearer(PAT_TOKEN));
    expect(res.status).toBe(401);
  });

  it('refuses the opaque token a pre-ISS-932 box holds, without reaching the verifier', async () => {
    const res = await makeApp().request('/me', bearer('abcd1234xxxxxxxxxxxxxxxxxxxxxxxx'));
    expect(res.status).toBe(401);
    expect(vi.mocked(verifyPat)).not.toHaveBeenCalled();
    expect(((await res.json()) as { message: string }).message).toMatch(/forge login/i);
  });

  it('returns 401 when the token does not verify', async () => {
    vi.mocked(verifyPat).mockResolvedValue(null);
    const res = await makeApp().request('/me', bearer(PAT_TOKEN));
    expect(res.status).toBe(401);
  });

  it.each([
    ['no Authorization header', undefined],
    ['a non-Bearer scheme', 'Basic abc123'],
    ['an empty Bearer token', 'Bearer    '],
  ])('returns 401 UNAUTHENTICATED for %s', async (_label, authorization) => {
    const res = await makeApp().request(
      '/me',
      authorization ? { headers: { authorization } } : undefined,
    );
    expect(res.status).toBe(401);
    expect(((await res.json()) as { code: string }).code).toBe('UNAUTHENTICATED');
    expect(vi.mocked(verifyPat)).not.toHaveBeenCalled();
  });

  it('does NOT populate c.get("user") — distinct principals', async () => {
    vi.mocked(verifyPat).mockResolvedValue({ row: patRow, ownerKind: 'human' } as never);
    selectLimit.mockResolvedValue([deviceRow]);
    const res = await makeApp().request('/principals', bearer(PAT_TOKEN));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { device: { id: string }; user: unknown };
    expect(body.device.id).toBe(DEVICE_ID);
    expect(body.user).toBeNull();
  });

  it('ignores forge_auth cookie — device auth is header-only', async () => {
    const res = await makeApp().request('/me', {
      headers: { cookie: 'forge_auth=some-user-jwt-value' },
    });
    expect(res.status).toBe(401);
    expect(vi.mocked(verifyPat)).not.toHaveBeenCalled();
  });
});
