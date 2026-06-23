/**
 * ISS-497 — POST /api/pat boundProjectId issuance + rotation preservation.
 * Covers: membership validation, mutual-exclusion rejection, publicShape
 * reflecting the binding, plaintext-once, and rotate preserving the binding.
 * Auth/db/pat primitives are mocked — this is a route-logic unit test.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../config/env.js', () => ({
  env: { PAT_MAX_PER_USER: 50, NODE_ENV: 'test' },
}));

vi.mock('../middleware/auth.js', () => ({
  requireAuth:
    () => async (c: { set: (k: string, v: string) => void }, next: () => Promise<void>) => {
      c.set('userId', 'user-1');
      return next();
    },
  assertEmailVerified: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));

vi.mock('../middleware/require-fresh-auth.js', () => ({
  requireFreshAuth: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));

vi.mock('../middleware/require-pat-or-device.js', () => ({
  forgetPatThrottle: vi.fn(),
}));

const countActivePatsForUser = vi.fn(async () => 0);
const mintPat = vi.fn();
const rotatePat = vi.fn();
const revokePat = vi.fn();
vi.mock('../auth/pat.js', () => ({
  countActivePatsForUser: (...a: unknown[]) => countActivePatsForUser(...(a as [])),
  mintPat: (...a: unknown[]) => mintPat(...(a as [])),
  rotatePat: (...a: unknown[]) => rotatePat(...(a as [])),
  revokePat: (...a: unknown[]) => revokePat(...(a as [])),
}));

const loadVisibleProjectIds = vi.fn(async () => [] as string[]);
vi.mock('../lib/authz.js', () => ({
  loadVisibleProjectIds: (...a: unknown[]) => loadVisibleProjectIds(...(a as [])),
}));

// name-conflict pre-check: select→from→where→limit → []
const selectLimit = vi.fn(async () => [] as unknown[]);
vi.mock('../db/client.js', () => ({
  db: {
    select: vi.fn(() => ({ from: () => ({ where: () => ({ limit: selectLimit }) }) })),
  },
}));

vi.mock('../ws/server.js', () => ({ roomManager: { publish: vi.fn() } }));
vi.mock('../ws/rooms.js', () => ({ userRoom: () => 'room' }));

const { patRoutes } = await import('./routes.js');

const BOUND = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

function mkRow(over: Record<string, unknown> = {}) {
  return {
    id: 'tok-1',
    name: 'my token',
    tokenPrefix: 'forge_pat_test_ab',
    disabledAt: null,
    scopes: ['read', 'write'],
    projectIds: null,
    boundProjectId: null,
    expiresAt: null,
    createdAt: new Date('2026-01-01'),
    lastUsedAt: null,
    lastUsedIp: null,
    revokedAt: null,
    ...over,
  };
}

function post(body: unknown) {
  return patRoutes.request('/pat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  countActivePatsForUser.mockResolvedValue(0);
  selectLimit.mockResolvedValue([]);
});

describe('POST /api/pat — boundProjectId', () => {
  it('mints a bound token for a project the caller is a member of', async () => {
    loadVisibleProjectIds.mockResolvedValue([BOUND]);
    mintPat.mockResolvedValue({
      row: mkRow({ boundProjectId: BOUND }),
      plaintext: 'forge_pat_test_secret',
    });

    const res = await post({ name: 'my token', boundProjectId: BOUND });
    expect(res.status).toBe(201);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.boundProjectId).toBe(BOUND);
    expect(json.plaintext).toBe('forge_pat_test_secret'); // plaintext exactly once
    expect(mintPat).toHaveBeenCalledWith(expect.objectContaining({ boundProjectId: BOUND }));
  });

  it('rejects a bound project the caller cannot access → FORBIDDEN_PROJECT', async () => {
    loadVisibleProjectIds.mockResolvedValue([]); // not a member of BOUND
    const res = await post({ name: 'my token', boundProjectId: BOUND });
    expect(res.status).toBe(403); // FORBIDDEN_PROJECT (HTTPException; mapped to code by global handler)
    expect(mintPat).not.toHaveBeenCalled();
  });

  it('rejects boundProjectId + multi-project projectIds → BAD_REQUEST (mutual exclusion)', async () => {
    loadVisibleProjectIds.mockResolvedValue([BOUND, OTHER]);
    const res = await post({ name: 'my token', boundProjectId: BOUND, projectIds: [OTHER] });
    expect(res.status).toBe(400);
    expect(mintPat).not.toHaveBeenCalled();
  });

  it('user-level token (no binding) still mints unchanged', async () => {
    mintPat.mockResolvedValue({ row: mkRow(), plaintext: 'forge_pat_test_secret' });
    const res = await post({ name: 'my token' });
    expect(res.status).toBe(201);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.boundProjectId).toBeNull();
    expect(mintPat).toHaveBeenCalledWith(expect.objectContaining({ boundProjectId: null }));
  });
});

describe('POST /api/pat/:id/rotate — preserves binding', () => {
  it('rotation returns a row carrying the original boundProjectId', async () => {
    rotatePat.mockResolvedValue({
      row: mkRow({ boundProjectId: BOUND }),
      plaintext: 'forge_pat_test_rotated',
    });
    const res = await patRoutes.request(`/pat/${BOUND}/rotate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.boundProjectId).toBe(BOUND);
    expect(json.plaintext).toBe('forge_pat_test_rotated');
  });
});
