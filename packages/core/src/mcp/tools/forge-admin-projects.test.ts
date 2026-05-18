import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config/env.js', () => ({
  env: {
    JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef',
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://localhost/stub',
  },
}));

const selectImpl = vi.fn();
const insertImpl = vi.fn();
const deleteImpl = vi.fn();
const transactionImpl = vi.fn();

vi.mock('../../db/client.js', () => ({
  db: {
    select: (...a: unknown[]) => selectImpl(...a),
    insert: (...a: unknown[]) => insertImpl(...a),
    delete: (...a: unknown[]) => deleteImpl(...a),
    transaction: (...a: unknown[]) => transactionImpl(...a),
  },
}));

const { forgeAdminProjectsTool } = await import('./forge-admin-projects.js');

const OWNER_ID = '11111111-1111-4111-8111-111111111111';
const NEW_OWNER_ID = '22222222-2222-4222-8222-222222222222';
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
  // assertPrincipalIsSystemAdmin: db.select({isCeo}).from(users).where().limit(1)
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
  insertImpl.mockReset();
  deleteImpl.mockReset();
  transactionImpl.mockReset();
});

describe('forge_admin_projects', () => {
  it('list returns shape with total + projects', async () => {
    mockCeoLookup(true);
    // count(*)
    selectImpl.mockImplementationOnce(() => ({
      from: () => Promise.resolve([{ total: 2 }]),
    }));
    // base list
    selectImpl.mockImplementationOnce(() => ({
      from: () => ({
        leftJoin: () => ({
          orderBy: () => ({
            limit: () => ({
              offset: () =>
                Promise.resolve([
                  {
                    id: PROJECT_ID,
                    slug: 'p1',
                    name: 'Project 1',
                    ownerId: OWNER_ID,
                    ownerEmail: 'a@b.co',
                    repoPath: null,
                    baseBranch: null,
                    createdAt: new Date(),
                  },
                ]),
            }),
          }),
        }),
      }),
    }));

    const tool = forgeAdminProjectsTool(buildCtx());
    const res = (await tool.handler({ action: 'list' })) as { projects: unknown[]; total: number };
    expect(res.total).toBe(2);
    expect(res.projects).toHaveLength(1);
  });

  it('list with includeStats:true attaches memberCount + issueCount', async () => {
    mockCeoLookup(true);
    selectImpl.mockImplementationOnce(() => ({
      from: () => Promise.resolve([{ total: 1 }]),
    }));
    selectImpl.mockImplementationOnce(() => ({
      from: () => ({
        leftJoin: () => ({
          orderBy: () => ({
            limit: () => ({
              offset: () =>
                Promise.resolve([
                  {
                    id: PROJECT_ID,
                    slug: 'p1',
                    name: 'Project 1',
                    ownerId: OWNER_ID,
                    ownerEmail: 'a@b.co',
                    repoPath: null,
                    baseBranch: null,
                    createdAt: new Date(),
                  },
                ]),
            }),
          }),
        }),
      }),
    }));
    // member counts
    selectImpl.mockImplementationOnce(() => ({
      from: () => ({
        where: () => ({
          groupBy: () => Promise.resolve([{ projectId: PROJECT_ID, n: 3 }]),
        }),
      }),
    }));
    // issue counts
    selectImpl.mockImplementationOnce(() => ({
      from: () => ({
        where: () => ({
          groupBy: () => Promise.resolve([{ projectId: PROJECT_ID, n: 7 }]),
        }),
      }),
    }));

    const tool = forgeAdminProjectsTool(buildCtx());
    const res = (await tool.handler({ action: 'list', includeStats: true })) as {
      projects: Array<{ memberCount: number; issueCount: number }>;
    };
    expect(res.projects[0].memberCount).toBe(3);
    expect(res.projects[0].issueCount).toBe(7);
  });

  it('create happy path returns project without apiKey', async () => {
    mockCeoLookup(true);
    transactionImpl.mockImplementationOnce(async (fn: (tx: unknown) => unknown) => {
      const tx = {
        insert: () => ({
          values: () => ({
            returning: () =>
              Promise.resolve([
                {
                  id: PROJECT_ID,
                  slug: 'new-proj',
                  name: 'New Project',
                  ownerId: NEW_OWNER_ID,
                  createdAt: new Date(),
                },
              ]),
          }),
        }),
      };
      // Second tx.insert (projectMembers) — same shape but values returns nothing.
      const tx2 = {
        ...tx,
        insert: () => ({
          values: () => Promise.resolve(undefined),
        }),
      };
      // First call: projects insert; second call: projectMembers insert.
      let n = 0;
      const proxy = {
        insert: () => {
          n++;
          if (n === 1) {
            return tx.insert();
          }
          return tx2.insert();
        },
      };
      return fn(proxy);
    });

    const tool = forgeAdminProjectsTool(buildCtx());
    const res = (await tool.handler({
      action: 'create',
      data: { slug: 'new-proj', name: 'New Project', ownerId: NEW_OWNER_ID },
    })) as { project: { id: string; slug: string } };
    expect(res.project.slug).toBe('new-proj');
    expect(res.project).not.toHaveProperty('apiKey');
  });

  it('create surfaces unique violation as BAD_REQUEST SLUG_TAKEN', async () => {
    mockCeoLookup(true);
    transactionImpl.mockImplementationOnce(async () => {
      const err = Object.assign(new Error('duplicate key value'), { code: '23505' });
      throw err;
    });
    const tool = forgeAdminProjectsTool(buildCtx());
    await expect(
      tool.handler({
        action: 'create',
        data: { slug: 'taken', name: 'X', ownerId: NEW_OWNER_ID },
      }),
    ).rejects.toThrow(/BAD_REQUEST: SLUG_TAKEN/);
  });

  it('archive without confirm:true throws BAD_REQUEST', async () => {
    mockCeoLookup(true);
    const tool = forgeAdminProjectsTool(buildCtx());
    await expect(
      tool.handler({ action: 'archive', projectId: PROJECT_ID, confirm: false }),
    ).rejects.toThrow(/BAD_REQUEST: archive requires confirm/);
  });

  it('archive with in-flight sessions throws PROJECT_BUSY', async () => {
    mockCeoLookup(true);
    selectImpl.mockImplementationOnce(() => ({
      from: () => ({
        where: () => Promise.resolve([{ active: 2 }]),
      }),
    }));
    const tool = forgeAdminProjectsTool(buildCtx());
    await expect(
      tool.handler({ action: 'archive', projectId: PROJECT_ID, confirm: true }),
    ).rejects.toThrow(/PROJECT_BUSY/);
  });

  it('archive happy path deletes and returns archived:true', async () => {
    mockCeoLookup(true);
    selectImpl.mockImplementationOnce(() => ({
      from: () => ({
        where: () => Promise.resolve([{ active: 0 }]),
      }),
    }));
    deleteImpl.mockImplementationOnce(() => ({
      where: () => ({
        returning: () => Promise.resolve([{ id: PROJECT_ID }]),
      }),
    }));
    const tool = forgeAdminProjectsTool(buildCtx());
    const res = (await tool.handler({
      action: 'archive',
      projectId: PROJECT_ID,
      confirm: true,
    })) as { archived: boolean };
    expect(res.archived).toBe(true);
  });

  it('system admin gate rejects project-scoped admin (cross-tenant probe)', async () => {
    mockCeoLookup(false);
    const tool = forgeAdminProjectsTool(buildCtx());
    await expect(tool.handler({ action: 'list' })).rejects.toThrow(/FORBIDDEN: requires system admin/);
  });
});
