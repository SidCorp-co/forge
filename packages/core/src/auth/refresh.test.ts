import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_SECRET = 'test-secret-at-least-32-chars-long-abcdef';

vi.mock('../config/env.js', () => ({
  env: { JWT_SECRET: TEST_SECRET, NODE_ENV: 'test' },
}));

// Tx builder state — reset in beforeEach.
type CandidateRow = {
  id: string;
  userId: string;
  tokenPrefix: string;
  tokenHash: string;
  expiresAt: Date;
  usedAt: Date | null;
  createdAt: Date;
};

const txState: {
  candidates: CandidateRow[];
  claimReturning: { id: string }[];
  selectCalls: number;
  txUpdateCalls: Array<{ setUsedAt: boolean; kind: 'byId' | 'other' }>;
  outerInvalidateCalls: number;
  insertValues: Array<Record<string, unknown>>;
  verifyImpl: (hash: string, raw: string) => Promise<boolean>;
  txCommitted: number;
} = {
  candidates: [],
  claimReturning: [],
  selectCalls: 0,
  txUpdateCalls: [],
  outerInvalidateCalls: 0,
  insertValues: [],
  verifyImpl: async () => false,
  txCommitted: 0,
};

function makeTx() {
  const tx = {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          for: vi.fn(async (_mode: string) => {
            txState.selectCalls += 1;
            return txState.candidates;
          }),
        })),
      })),
    })),
    update: vi.fn(() => {
      const call: { setUsedAt: boolean; kind: 'byId' | 'other' } = {
        setUsedAt: false,
        kind: 'other',
      };
      txState.txUpdateCalls.push(call);
      return {
        set: vi.fn((patch: Record<string, unknown>) => {
          if ('usedAt' in patch) call.setUsedAt = true;
          return {
            where: vi.fn((_expr: unknown) => ({
              returning: vi.fn(async () => {
                call.kind = 'byId';
                return txState.claimReturning;
              }),
            })),
          };
        }),
      };
    }),
    insert: vi.fn(() => ({
      values: vi.fn(async (v: Record<string, unknown>) => {
        txState.insertValues.push(v);
      }),
    })),
  };
  return tx;
}

// The outer db.update() path is only hit by the post-rollback mass-invalidate
// (replay / concurrent-race). Counting it proves the invalidation is committed
// OUTSIDE the rotation transaction.
const outerDbUpdate = vi.fn(() => ({
  set: vi.fn(() => ({
    where: vi.fn(async (_expr: unknown) => {
      txState.outerInvalidateCalls += 1;
    }),
  })),
}));

vi.mock('../db/client.js', () => ({
  db: {
    transaction: vi.fn(async (cb: (tx: ReturnType<typeof makeTx>) => Promise<unknown>) => {
      const result = await cb(makeTx());
      txState.txCommitted += 1;
      return result;
    }),
    update: outerDbUpdate,
  },
}));

vi.mock('./refresh-token.js', async () => {
  const actual = await vi.importActual<typeof import('./refresh-token.js')>('./refresh-token.js');
  return {
    ...actual,
    generateRefreshToken: vi.fn(() => ({ raw: 'NEWRAW__rest_of_token', prefix: 'NEWRAW__' })),
    hashRefreshToken: vi.fn(async () => 'new-hash'),
    verifyRefreshToken: vi.fn((hash: string, raw: string) => txState.verifyImpl(hash, raw)),
  };
});

const { refreshRoutes } = await import('./refresh.js');
const { verifyUserToken } = await import('./jwt.js');
const { errorHandler } = await import('../middleware/error.js');
const { requestId } = await import('../middleware/request-id.js');

function buildApp() {
  const app = new Hono<{ Variables: import('../middleware/request-id.js').RequestIdVars }>();
  app.use('*', requestId());
  app.route('/api/auth', refreshRoutes);
  app.onError(errorHandler);
  return app;
}

/**
 * Build the request with the refresh token in the httpOnly cookie. The
 * route only reads the cookie since the post-ISS-315 cleanup; the legacy
 * JSON body path is gone.
 */
function postWithCookie(refreshToken?: string) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (refreshToken !== undefined) {
    headers.cookie = `forge_refresh=${refreshToken}`;
  }
  return buildApp().request('/api/auth/refresh', {
    method: 'POST',
    headers,
  });
}

function row(overrides: Partial<CandidateRow> = {}): CandidateRow {
  return {
    id: 'row-1',
    userId: 'user-1',
    tokenPrefix: 'PRESENTE',
    tokenHash: 'stored-hash',
    expiresAt: new Date(Date.now() + 60_000),
    usedAt: null,
    createdAt: new Date(),
    ...overrides,
  };
}

beforeEach(() => {
  txState.candidates = [];
  txState.claimReturning = [];
  txState.selectCalls = 0;
  txState.txUpdateCalls = [];
  txState.outerInvalidateCalls = 0;
  txState.insertValues = [];
  txState.verifyImpl = async () => false;
  txState.txCommitted = 0;
  outerDbUpdate.mockClear();
});

describe('POST /api/auth/refresh', () => {
  const presentedRaw = 'PRESENTEDtoken-valid';

  it('valid refresh → 200 with new JWT + new refresh cookie, old row marked used, new row inserted', async () => {
    const matched = row({ id: 'row-1', userId: 'user-1' });
    txState.candidates = [matched];
    txState.verifyImpl = async (_h, r) => r === presentedRaw;
    txState.claimReturning = [{ id: 'row-1' }];

    const res = await postWithCookie(presentedRaw);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string; refreshToken?: string };

    const claims = await verifyUserToken(body.token);
    expect(claims.sub).toBe('user-1');
    expect(claims.typ).toBe('user');
    // refreshToken no longer in JSON — rides the forge_refresh cookie.
    expect(body.refreshToken).toBeUndefined();

    // Both cookies set on rotation.
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('forge_auth=');
    expect(setCookie).toContain('forge_refresh=');
    expect(setCookie).toContain('HttpOnly');

    // Exactly one tx UPDATE (the claim-by-id). No outer mass-invalidate.
    expect(txState.txUpdateCalls).toHaveLength(1);
    expect(txState.txUpdateCalls[0]?.setUsedAt).toBe(true);
    expect(txState.txUpdateCalls[0]?.kind).toBe('byId');
    expect(txState.outerInvalidateCalls).toBe(0);

    // New row inserted.
    expect(txState.insertValues).toHaveLength(1);
    expect(txState.insertValues[0]).toMatchObject({
      userId: 'user-1',
      tokenPrefix: 'NEWRAW__',
      tokenHash: 'new-hash',
    });
    expect(txState.insertValues[0]?.expiresAt).toBeInstanceOf(Date);
  });

  it('replay (usedAt already set) → 401 REFRESH_TOKEN_REUSED + mass-invalidate committed OUTSIDE rotation tx, no insert', async () => {
    txState.candidates = [row({ usedAt: new Date(Date.now() - 1000) })];
    txState.verifyImpl = async () => true;

    const res = await postWithCookie(presentedRaw);
    expect(res.status).toBe(401);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('REFRESH_TOKEN_REUSED');

    // No UPDATE inside the rotation tx (so nothing can be rolled back with it).
    expect(txState.txUpdateCalls).toHaveLength(0);
    // Rotation tx still committed (returned a sentinel).
    expect(txState.txCommitted).toBe(1);
    // Mass-invalidate ran on the outer db, committed independently.
    expect(txState.outerInvalidateCalls).toBe(1);
    expect(txState.insertValues).toHaveLength(0);
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('expired refresh → 401 REFRESH_TOKEN_EXPIRED, no update anywhere, no insert', async () => {
    txState.candidates = [row({ expiresAt: new Date(Date.now() - 1000) })];
    txState.verifyImpl = async () => true;

    const res = await postWithCookie(presentedRaw);
    expect(res.status).toBe(401);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('REFRESH_TOKEN_EXPIRED');

    expect(txState.txUpdateCalls).toHaveLength(0);
    expect(txState.outerInvalidateCalls).toBe(0);
    expect(txState.insertValues).toHaveLength(0);
  });

  it('unknown token (no prefix match) → 401 INVALID_REFRESH_TOKEN, no mass-invalidate', async () => {
    txState.candidates = [];

    const res = await postWithCookie(presentedRaw);
    expect(res.status).toBe(401);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('INVALID_REFRESH_TOKEN');
    expect(txState.txUpdateCalls).toHaveLength(0);
    expect(txState.outerInvalidateCalls).toBe(0);
    expect(txState.insertValues).toHaveLength(0);
  });

  it('hash mismatch on all candidates → 401 INVALID_REFRESH_TOKEN', async () => {
    txState.candidates = [row(), row({ id: 'row-2' })];
    txState.verifyImpl = async () => false;

    const res = await postWithCookie(presentedRaw);
    expect(res.status).toBe(401);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('INVALID_REFRESH_TOKEN');
    expect(txState.txUpdateCalls).toHaveLength(0);
    expect(txState.outerInvalidateCalls).toBe(0);
  });

  it('concurrent race (claim UPDATE returns 0 rows) → 401 REFRESH_TOKEN_REUSED + mass-invalidate committed OUTSIDE rotation tx', async () => {
    txState.candidates = [row()];
    txState.verifyImpl = async () => true;
    txState.claimReturning = []; // someone else claimed it

    const res = await postWithCookie(presentedRaw);
    expect(res.status).toBe(401);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('REFRESH_TOKEN_REUSED');

    // One tx UPDATE (claim-by-id returning 0 rows), mass-invalidate is outer.
    expect(txState.txUpdateCalls).toHaveLength(1);
    expect(txState.txUpdateCalls[0]?.kind).toBe('byId');
    expect(txState.txCommitted).toBe(1);
    expect(txState.outerInvalidateCalls).toBe(1);
    expect(txState.insertValues).toHaveLength(0);
  });

  // The route reads refresh token only from the httpOnly cookie. No cookie
  // → 401 (same code a forged token would yield, so a probe can't tell
  // "no cookie" from "wrong cookie" apart).
  it('missing refresh cookie → 401 INVALID_REFRESH_TOKEN', async () => {
    const res = await postWithCookie();
    expect(res.status).toBe(401);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('INVALID_REFRESH_TOKEN');
    expect(txState.selectCalls).toBe(0);
  });
});
