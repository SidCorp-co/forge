import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../config/env.js', () => ({ env: { NODE_ENV: 'test' } }));

const mintPat = vi.fn(async (_input: unknown, _tx?: unknown) => ({
  plaintext: 'forge_pat_dev_minted',
}));
// `lockPatName` is the real one: what this file asserts about the lock is the
// statement it puts on the handle, which a stub would have to restate.
vi.mock('../auth/pat.js', async () => {
  const actual = await vi.importActual<typeof import('../auth/pat.js')>('../auth/pat.js');
  return {
    lockPatName: actual.lockPatName,
    mintPat: (i: unknown, tx?: unknown) => mintPat(i, tx),
  };
});

const execute = vi.fn(async () => undefined);
const updateWhere = vi.fn(async () => undefined);
const updateSet = vi.fn(() => ({ where: updateWhere }));
const update = vi.fn(() => ({ set: updateSet }));

const limit = vi.fn(async () => [{ userId: 'agent-7' }]);
const selectWhere = vi.fn(() => ({ limit }));
const from = vi.fn(() => ({ where: selectWhere }));
const select = vi.fn(() => ({ from }));

const tx = { execute, update, select };
const transaction = vi.fn(async (run: (t: typeof tx) => Promise<unknown>) => run(tx));

vi.mock('../db/client.js', () => ({ db: { transaction, select } }));

const { deviceHolderUserId, issueWorkspaceCredential } = await import('./workspace-credential.js');

beforeEach(() => {
  vi.clearAllMocks();
  limit.mockResolvedValue([{ userId: 'agent-7' }]);
});

describe('deviceHolderUserId', () => {
  it('answers the holder of the live device credential — the agent, not the pairer', async () => {
    await expect(deviceHolderUserId('dev-1')).resolves.toBe('agent-7');
  });

  it('is null when the device has no live credential', async () => {
    limit.mockResolvedValue([]);
    await expect(deviceHolderUserId('dev-1')).resolves.toBeNull();
  });
});

/**
 * What this file can and cannot answer for.
 *
 * `db` is a mock here, so `pat_user_name_uniq` is not representable in the
 * runtime that runs these — which is exactly how ISS-1184 shipped with this
 * file green beside it: the revoke left the row, the mint collided with it, and
 * nothing here could see the index that refused. The properties that need a
 * real Postgres — concurrent mints, the rollback, the name reused after a
 * revoke — are in `tests/integration/pat-name-after-revoke-e2e.test.ts` and
 * belong there. What is left below is the shape of the call.
 */
describe('issueWorkspaceCredential', () => {
  it('fences the token to the one project and binds it to the device', async () => {
    const token = await issueWorkspaceCredential({
      deviceId: 'dev-1',
      projectId: 'proj-9',
      holderUserId: 'agent-7',
    });

    expect(token).toBe('forge_pat_dev_minted');
    expect(mintPat).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'agent-7',
        name: 'workspace:dev-1:proj-9',
        projectIds: ['proj-9'],
        deviceId: 'dev-1',
        scopes: ['read', 'write'],
      }),
      tx,
    );
  });

  it('revokes and mints on one transaction, so a failed mint cannot strand the checkout', async () => {
    await issueWorkspaceCredential({
      deviceId: 'dev-1',
      projectId: 'proj-9',
      holderUserId: 'agent-7',
    });

    expect(transaction).toHaveBeenCalledTimes(1);
    // The lock comes first, then the revoke, then the mint — and the mint is
    // handed the same handle, or it would commit outside the rollback.
    expect(execute.mock.invocationCallOrder[0]).toBeLessThan(
      update.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(update.mock.invocationCallOrder[0]).toBeLessThan(
      mintPat.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(updateSet).toHaveBeenCalledWith(
      expect.objectContaining({ revokedAt: expect.anything() }),
    );
  });

  it('takes the advisory lock on the token name, so two requests for one checkout are ordered', async () => {
    await issueWorkspaceCredential({
      deviceId: 'dev-1',
      projectId: 'proj-9',
      holderUserId: 'agent-7',
    });
    const [statement] = execute.mock.calls[0] as unknown as [{ queryChunks?: unknown[] }];
    expect(JSON.stringify(statement)).toContain('pg_advisory_xact_lock');
    expect(JSON.stringify(statement)).toContain('workspace:dev-1:proj-9');
  });
});
