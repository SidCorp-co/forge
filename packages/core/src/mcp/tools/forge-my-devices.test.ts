import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config/env.js', () => ({
  env: {
    JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef',
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://localhost/stub',
  },
}));

const selectImpl = vi.fn();
const updateImpl = vi.fn();
const deleteImpl = vi.fn();
const transactionImpl = vi.fn();

vi.mock('../../db/client.js', () => ({
  db: {
    select: (...a: unknown[]) => selectImpl(...a),
    update: (...a: unknown[]) => updateImpl(...a),
    delete: (...a: unknown[]) => deleteImpl(...a),
    transaction: (...a: unknown[]) => transactionImpl(...a),
  },
}));

const { forgeMyDevicesTool } = await import('./forge-my-devices.js');

const OWNER_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_USER_ID = '22222222-2222-4222-8222-222222222222';
const DEVICE_ID = '44444444-4444-4444-8444-444444444444';
const OTHER_DEVICE_ID = '55555555-5555-4555-8555-555555555555';
const TOKEN_ID = '66666666-6666-4666-8666-666666666666';

const fakeDevice = {
  id: DEVICE_ID,
  ownerId: OWNER_ID,
  name: 'fake',
  platform: 'linux' as const,
  agentVersion: null,
  tokenHash: '$argon2id$v=19$m=1,t=1,p=1$ZQ$ZQ',
  tokenPrefix: 'fake0001',
  status: 'online' as const,
  lastSeenAt: null,
  pairedAt: new Date(),
  capabilities: null,
  createdAt: new Date(),
};

function buildCtx() {
  return {
    principal: { kind: 'device' as const, device: fakeDevice },
    device: fakeDevice,
    projectSlug: null,
  };
}

function buildPatCtx(scopes: readonly string[]) {
  return {
    principal: {
      kind: 'pat' as const,
      userId: OWNER_ID,
      tokenId: TOKEN_ID,
      scopes,
      projectIds: null,
    },
    device: fakeDevice,
    projectSlug: null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  selectImpl.mockReset();
  updateImpl.mockReset();
  deleteImpl.mockReset();
  transactionImpl.mockReset();
});

describe('forge_my_devices', () => {
  it('list returns rows scoped to ownerId and never leaks tokenHash/tokenPrefix', async () => {
    selectImpl.mockImplementationOnce(() => ({
      from: () => ({
        where: () => ({
          orderBy: () =>
            Promise.resolve([
              {
                id: DEVICE_ID,
                name: 'laptop',
                platform: 'linux',
                agentVersion: '0.1.0',
                status: 'online',
                lastSeenAt: null,
                pairedAt: new Date(),
                capabilities: null,
                createdAt: new Date(),
              },
            ]),
        }),
      }),
    }));
    const tool = forgeMyDevicesTool(buildCtx());
    const res = (await tool.handler({ action: 'list' })) as {
      devices: Array<Record<string, unknown>>;
    };
    expect(res.devices).toHaveLength(1);
    expect(res.devices[0].id).toBe(DEVICE_ID);
    expect(res.devices[0]).not.toHaveProperty('tokenHash');
    expect(res.devices[0]).not.toHaveProperty('tokenPrefix');
  });

  it('list works for PAT principal (no admin scope required)', async () => {
    selectImpl.mockImplementationOnce(() => ({
      from: () => ({
        where: () => ({
          orderBy: () => Promise.resolve([]),
        }),
      }),
    }));
    const tool = forgeMyDevicesTool(buildPatCtx(['read']));
    const res = (await tool.handler({ action: 'list' })) as {
      devices: unknown[];
    };
    expect(res.devices).toEqual([]);
  });

  it('rename happy path returns updated subset', async () => {
    selectImpl.mockImplementationOnce(() => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve([{ ownerId: OWNER_ID }]),
        }),
      }),
    }));
    updateImpl.mockImplementationOnce(() => ({
      set: () => ({
        where: () => ({
          returning: () =>
            Promise.resolve([
              {
                id: DEVICE_ID,
                name: 'renamed-laptop',
                platform: 'linux',
                status: 'online',
                lastSeenAt: null,
                pairedAt: new Date(),
              },
            ]),
        }),
      }),
    }));
    const tool = forgeMyDevicesTool(buildCtx());
    const res = (await tool.handler({
      action: 'rename',
      deviceId: DEVICE_ID,
      name: 'renamed-laptop',
    })) as { device: { name: string } };
    expect(res.device.name).toBe('renamed-laptop');
  });

  it('rename FORBIDDEN when device ownerId mismatches principal', async () => {
    selectImpl.mockImplementationOnce(() => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve([{ ownerId: OTHER_USER_ID }]),
        }),
      }),
    }));
    const tool = forgeMyDevicesTool(buildCtx());
    await expect(
      tool.handler({
        action: 'rename',
        deviceId: OTHER_DEVICE_ID,
        name: 'mine-now',
      }),
    ).rejects.toThrow(/FORBIDDEN: not the device owner/);
  });

  it('rename BAD_REQUEST when name missing', async () => {
    const tool = forgeMyDevicesTool(buildCtx());
    await expect(
      tool.handler({ action: 'rename', deviceId: DEVICE_ID }),
    ).rejects.toThrow(/BAD_REQUEST: name is required/);
  });

  it('rename NOT_FOUND when deviceId does not exist', async () => {
    selectImpl.mockImplementationOnce(() => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve([]),
        }),
      }),
    }));
    const tool = forgeMyDevicesTool(buildCtx());
    await expect(
      tool.handler({
        action: 'rename',
        deviceId: OTHER_DEVICE_ID,
        name: 'x',
      }),
    ).rejects.toThrow(/NOT_FOUND: device not found/);
  });

  it('revoke happy path: status=revoked + transaction invoked', async () => {
    selectImpl.mockImplementationOnce(() => ({
      from: () => ({
        where: () => ({
          limit: () =>
            Promise.resolve([{ ownerId: OWNER_ID, status: 'online' }]),
        }),
      }),
    }));
    transactionImpl.mockImplementationOnce(
      async (fn: (tx: unknown) => unknown) => {
        const tx = {
          update: () => ({
            set: () => ({
              where: () => Promise.resolve(undefined),
            }),
          }),
          delete: () => ({
            where: () => Promise.resolve(undefined),
          }),
        };
        return fn(tx);
      },
    );
    const tool = forgeMyDevicesTool(buildCtx());
    const res = (await tool.handler({
      action: 'revoke',
      deviceId: DEVICE_ID,
    })) as { device: { id: string; status: string } };
    expect(res.device).toEqual({ id: DEVICE_ID, status: 'revoked' });
    expect(transactionImpl).toHaveBeenCalledTimes(1);
  });

  it('revoke FORBIDDEN on owner mismatch', async () => {
    selectImpl.mockImplementationOnce(() => ({
      from: () => ({
        where: () => ({
          limit: () =>
            Promise.resolve([
              { ownerId: OTHER_USER_ID, status: 'online' },
            ]),
        }),
      }),
    }));
    const tool = forgeMyDevicesTool(buildCtx());
    await expect(
      tool.handler({ action: 'revoke', deviceId: OTHER_DEVICE_ID }),
    ).rejects.toThrow(/FORBIDDEN: not the device owner/);
    expect(transactionImpl).not.toHaveBeenCalled();
  });

  it('revoke NOT_FOUND when deviceId does not exist', async () => {
    selectImpl.mockImplementationOnce(() => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve([]),
        }),
      }),
    }));
    const tool = forgeMyDevicesTool(buildCtx());
    await expect(
      tool.handler({ action: 'revoke', deviceId: OTHER_DEVICE_ID }),
    ).rejects.toThrow(/NOT_FOUND: device not found/);
  });

  it('schema rejects unknown action', async () => {
    const tool = forgeMyDevicesTool(buildCtx());
    await expect(
      tool.handler({ action: 'destroy', deviceId: DEVICE_ID }),
    ).rejects.toThrow();
  });
});
