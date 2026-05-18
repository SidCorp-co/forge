import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config/env.js', () => ({
  env: {
    JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef',
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://localhost/stub',
  },
}));

const selectImpl = vi.fn();

vi.mock('../../db/client.js', () => ({
  db: {
    select: (...a: unknown[]) => selectImpl(...a),
  },
}));

const { forgeAdminUsersTool } = await import('./forge-admin-users.js');

const OWNER_ID = '11111111-1111-4111-8111-111111111111';
const USER_A = '22222222-2222-4222-8222-222222222222';
const PROJECT_ID = '33333333-3333-4333-8333-333333333333';
const DEVICE_ID = '44444444-4444-4444-8444-444444444444';

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

function mockCeoLookup(isCeo: boolean) {
  selectImpl.mockImplementationOnce(() => ({
    from: () => ({
      where: () => ({
        limit: () => Promise.resolve([{ isCeo }]),
      }),
    }),
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
  selectImpl.mockReset();
});

describe('forge_admin_users', () => {
  it('list returns memberships matrix and never exposes passwordHash', async () => {
    mockCeoLookup(true);
    // count(*)
    selectImpl.mockImplementationOnce(() => ({
      from: () => ({
        where: () => Promise.resolve([{ total: 1 }]),
      }),
    }));
    // user rows
    selectImpl.mockImplementationOnce(() => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({
            limit: () => ({
              offset: () =>
                Promise.resolve([
                  {
                    id: USER_A,
                    email: 'a@example.com',
                    isCeo: false,
                    emailVerifiedAt: null,
                    createdAt: new Date(),
                  },
                ]),
            }),
          }),
        }),
      }),
    }));
    // memberships
    selectImpl.mockImplementationOnce(() => ({
      from: () => ({
        innerJoin: () => ({
          where: () =>
            Promise.resolve([
              {
                userId: USER_A,
                projectId: PROJECT_ID,
                projectSlug: 'p1',
                role: 'admin',
              },
            ]),
        }),
      }),
    }));

    const tool = forgeAdminUsersTool(buildCtx());
    const res = (await tool.handler({ action: 'list' })) as {
      users: Array<{ id: string; memberships: Array<{ role: string }> }>;
      total: number;
    };
    expect(res.total).toBe(1);
    expect(res.users[0].memberships[0].role).toBe('admin');
    expect(res.users[0]).not.toHaveProperty('passwordHash');
  });

  it('list with search returns empty + total when no users match', async () => {
    mockCeoLookup(true);
    selectImpl.mockImplementationOnce(() => ({
      from: () => ({
        where: () => Promise.resolve([{ total: 0 }]),
      }),
    }));
    selectImpl.mockImplementationOnce(() => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({
            limit: () => ({
              offset: () => Promise.resolve([]),
            }),
          }),
        }),
      }),
    }));
    const tool = forgeAdminUsersTool(buildCtx());
    const res = (await tool.handler({ action: 'list', search: 'nomatch' })) as {
      users: unknown[];
      total: number;
    };
    expect(res.users).toEqual([]);
    expect(res.total).toBe(0);
  });

  it('FORBIDDEN when not CEO', async () => {
    mockCeoLookup(false);
    const tool = forgeAdminUsersTool(buildCtx());
    await expect(tool.handler({ action: 'list' })).rejects.toThrow(/FORBIDDEN/);
  });
});
