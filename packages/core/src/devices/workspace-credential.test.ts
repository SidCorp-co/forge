import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../config/env.js', () => ({ env: { NODE_ENV: 'test' } }));

const mintPat = vi.fn(async (_input: unknown) => ({ plaintext: 'forge_pat_dev_minted' }));
vi.mock('../auth/pat.js', () => ({ mintPat: (i: unknown) => mintPat(i) }));

const updateWhere = vi.fn(async () => undefined);
const updateSet = vi.fn(() => ({ where: updateWhere }));
const update = vi.fn(() => ({ set: updateSet }));

const limit = vi.fn(async () => [{ userId: 'agent-7' }]);
const selectWhere = vi.fn(() => ({ limit }));
const from = vi.fn(() => ({ where: selectWhere }));
const select = vi.fn(() => ({ from }));

vi.mock('../db/client.js', () => ({ db: { update, select } }));

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
    );
  });

  it('revokes the previous credential for the same checkout before minting', async () => {
    await issueWorkspaceCredential({
      deviceId: 'dev-1',
      projectId: 'proj-9',
      holderUserId: 'agent-7',
    });

    expect(update).toHaveBeenCalled();
    expect(updateSet).toHaveBeenCalledWith(
      expect.objectContaining({ revokedAt: expect.anything() }),
    );
    // Revocation happens first: a re-provision must not leave two live tokens
    // for one checkout.
    const revokedAt = update.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY;
    const mintedAt = mintPat.mock.invocationCallOrder[0] ?? 0;
    expect(revokedAt).toBeLessThan(mintedAt);
  });
});
