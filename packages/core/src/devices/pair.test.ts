import { HTTPException } from 'hono/http-exception';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_PEPPER = 'y'.repeat(32);

vi.mock('../config/env.js', () => ({
  env: { DEVICE_TOKEN_PEPPER: TEST_PEPPER, NODE_ENV: 'test' },
}));

const issueDeviceToken = vi.fn(async () => ({
  device: { id: 'dev-new', ownerId: 'u-1', name: 'laptop', platform: 'linux', status: 'offline' },
  plaintext: 'tok-plaintext',
}));

vi.mock('../auth/deviceToken.js', () => ({
  issueDeviceToken: (input: unknown) => issueDeviceToken(input),
}));

const txExecute = vi.fn();
const txUpdateWhere = vi.fn(async () => ({ rowCount: 1 }));
const txUpdateSet = vi.fn(() => ({ where: txUpdateWhere }));
const txUpdate = vi.fn(() => ({ set: txUpdateSet }));

const transaction = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
  const tx = { execute: txExecute, update: txUpdate };
  return fn(tx);
});

vi.mock('../db/client.js', () => ({
  db: { transaction },
}));

const { redeemPairingCode } = await import('./pair.js');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('redeemPairingCode', () => {
  it('throws INVALID_CODE when code not found', async () => {
    txExecute.mockResolvedValueOnce([]);
    const err = await redeemPairingCode({
      code: 'nope',
      name: 'laptop',
      platform: 'linux',
    }).catch((e) => e);
    expect(err).toBeInstanceOf(HTTPException);
    expect((err.cause as { code: string }).code).toBe('INVALID_CODE');
  });

  it('throws CODE_ALREADY_USED when usedAt is set', async () => {
    txExecute.mockResolvedValueOnce([
      {
        code: 'c1',
        user_id: 'u-1',
        project_id: null,
        expires_at: new Date(Date.now() + 60_000),
        used_at: new Date(Date.now() - 1000),
      },
    ]);
    const err = await redeemPairingCode({
      code: 'c1',
      name: 'laptop',
      platform: 'linux',
    }).catch((e) => e);
    expect((err.cause as { code: string }).code).toBe('CODE_ALREADY_USED');
  });

  it('throws CODE_EXPIRED when expiresAt in past', async () => {
    txExecute.mockResolvedValueOnce([
      {
        code: 'c1',
        user_id: 'u-1',
        project_id: null,
        expires_at: new Date(Date.now() - 1000),
        used_at: null,
      },
    ]);
    const err = await redeemPairingCode({
      code: 'c1',
      name: 'laptop',
      platform: 'linux',
    }).catch((e) => e);
    expect((err.cause as { code: string }).code).toBe('CODE_EXPIRED');
  });

  it('issues token and returns projectId null for user-scoped code', async () => {
    txExecute.mockResolvedValueOnce([
      {
        code: 'c1',
        user_id: 'u-1',
        project_id: null,
        expires_at: new Date(Date.now() + 60_000),
        used_at: null,
      },
    ]);
    const result = await redeemPairingCode({
      code: 'c1',
      name: 'laptop',
      platform: 'linux',
    });
    expect(result.plaintext).toBe('tok-plaintext');
    expect(result.device.id).toBe('dev-new');
    expect(result.projectId).toBeNull();
    expect(issueDeviceToken).toHaveBeenCalledOnce();
    // consume + (no project bind) — 1 select + 0 project update
    expect(txExecute).toHaveBeenCalledTimes(1);
    expect(txUpdate).toHaveBeenCalledOnce();
  });

  it('auto-binds activeDeviceId when projectId present', async () => {
    txExecute
      .mockResolvedValueOnce([
        {
          code: 'c1',
          user_id: 'u-1',
          project_id: 'proj-1',
          expires_at: new Date(Date.now() + 60_000),
          used_at: null,
        },
      ])
      .mockResolvedValueOnce({ rowCount: 1 });
    const result = await redeemPairingCode({
      code: 'c1',
      name: 'laptop',
      platform: 'linux',
    });
    expect(result.projectId).toBe('proj-1');
    // select + auto-bind activeDeviceId + insert runner row = 3 execute calls
    expect(txExecute).toHaveBeenCalledTimes(3);
  });
});
