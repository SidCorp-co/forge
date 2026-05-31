import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config/env.js', () => ({
  env: {
    JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef',
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://localhost/stub',
  },
}));

const selectImpl = vi.fn();
const selectDistinctImpl = vi.fn();
const insertImpl = vi.fn();
const deleteImpl = vi.fn();
const transactionImpl = vi.fn();

vi.mock('../../db/client.js', () => ({
  db: {
    select: (...a: unknown[]) => selectImpl(...a),
    selectDistinct: (...a: unknown[]) => selectDistinctImpl(...a),
    insert: (...a: unknown[]) => insertImpl(...a),
    delete: (...a: unknown[]) => deleteImpl(...a),
    transaction: (...a: unknown[]) => transactionImpl(...a),
  },
}));

const { forgeAdminProjectsTool } = await import('./forge-admin-projects.js');

const OWNER_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_OWNER_ID = '22222222-2222-4222-8222-222222222222';
const PROJECT_ID = '33333333-3333-4333-8333-333333333333';
const DEVICE_ID = '44444444-4444-4444-8444-444444444444';
const TOKEN_ID = '55555555-5555-4555-8555-555555555555';

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

function buildPatCtx(scopes: readonly string[], projectIds: string[] | null = null) {
  return {
    principal: {
      kind: 'pat' as const,
      userId: OWNER_ID,
      tokenId: TOKEN_ID,
      scopes,
      projectIds,
    },
    device: fakeDevice,
    projectSlug: null,
  };
}

// loadVisibleProjectIdsForPrincipal: db.selectDistinct({id}).from(projects)
// .leftJoin(projectMembers).where(...) → rows of { id }.
function mockVisibleProjects(ids: string[]) {
  selectDistinctImpl.mockImplementationOnce(() => ({
    from: () => ({
      leftJoin: () => ({
        where: () => Promise.resolve(ids.map((id) => ({ id }))),
      }),
    }),
  }));
}

// assertPrincipalIsAdmin → loadDeviceProjectRole/loadUserProjectRole:
// db.select({ownerId}).from(projects).where().limit(1).
function mockOwnerLookup(ownerId: string) {
  selectImpl.mockImplementationOnce(() => ({
    from: () => ({ where: () => ({ limit: () => Promise.resolve([{ ownerId }]) }) }),
  }));
}

const projectRow = {
  id: PROJECT_ID,
  slug: 'p1',
  name: 'Project 1',
  ownerId: OWNER_ID,
  ownerEmail: 'a@b.co',
  repoPath: null,
  baseBranch: null,
  createdAt: new Date(),
};

beforeEach(() => {
  vi.clearAllMocks();
  selectImpl.mockReset();
  selectDistinctImpl.mockReset();
  insertImpl.mockReset();
  deleteImpl.mockReset();
  transactionImpl.mockReset();
});

describe('forge_admin_projects', () => {
  it('list returns shape with total + projects scoped to visible', async () => {
    mockVisibleProjects([PROJECT_ID]);
    // count(*) WHERE id IN visible
    selectImpl.mockImplementationOnce(() => ({
      from: () => ({ where: () => Promise.resolve([{ total: 1 }]) }),
    }));
    // base list
    selectImpl.mockImplementationOnce(() => ({
      from: () => ({
        leftJoin: () => ({
          where: () => ({
            orderBy: () => ({
              limit: () => ({
                offset: () => Promise.resolve([projectRow]),
              }),
            }),
          }),
        }),
      }),
    }));

    const tool = forgeAdminProjectsTool(buildCtx());
    const res = (await tool.handler({ action: 'list' })) as { projects: unknown[]; total: number };
    expect(res.total).toBe(1);
    expect(res.projects).toHaveLength(1);
  });

  it('list returns empty when caller has no visible projects', async () => {
    mockVisibleProjects([]);
    const tool = forgeAdminProjectsTool(buildCtx());
    const res = (await tool.handler({ action: 'list' })) as { projects: unknown[]; total: number };
    expect(res.total).toBe(0);
    expect(res.projects).toEqual([]);
  });

  it('list with includeStats:true attaches memberCount + issueCount', async () => {
    mockVisibleProjects([PROJECT_ID]);
    selectImpl.mockImplementationOnce(() => ({
      from: () => ({ where: () => Promise.resolve([{ total: 1 }]) }),
    }));
    selectImpl.mockImplementationOnce(() => ({
      from: () => ({
        leftJoin: () => ({
          where: () => ({
            orderBy: () => ({
              limit: () => ({
                offset: () => Promise.resolve([projectRow]),
              }),
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

  it('list narrows to the PAT projectIds allowlist', async () => {
    // owned/member returns two projects; the PAT allowlist keeps only one.
    mockVisibleProjects([PROJECT_ID, OTHER_OWNER_ID]);
    selectImpl.mockImplementationOnce(() => ({
      from: () => ({ where: () => Promise.resolve([{ total: 1 }]) }),
    }));
    selectImpl.mockImplementationOnce(() => ({
      from: () => ({
        leftJoin: () => ({
          where: () => ({
            orderBy: () => ({
              limit: () => ({
                offset: () => Promise.resolve([projectRow]),
              }),
            }),
          }),
        }),
      }),
    }));

    const tool = forgeAdminProjectsTool(buildPatCtx(['read'], [PROJECT_ID]));
    const res = (await tool.handler({ action: 'list' })) as { projects: unknown[]; total: number };
    expect(res.projects).toHaveLength(1);
  });

  it('create happy path makes the caller the owner and omits apiKey', async () => {
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
                  ownerId: OWNER_ID,
                  createdAt: new Date(),
                },
              ]),
          }),
        }),
      };
      const tx2 = {
        ...tx,
        insert: () => ({
          values: () => Promise.resolve(undefined),
        }),
      };
      let n = 0;
      const proxy = {
        insert: () => {
          n++;
          if (n === 1) return tx.insert();
          return tx2.insert();
        },
      };
      return fn(proxy);
    });

    const tool = forgeAdminProjectsTool(buildCtx());
    const res = (await tool.handler({
      action: 'create',
      data: { slug: 'new-proj', name: 'New Project' },
    })) as { project: { id: string; slug: string; ownerId: string } };
    expect(res.project.slug).toBe('new-proj');
    expect(res.project.ownerId).toBe(OWNER_ID);
    expect(res.project).not.toHaveProperty('apiKey');
  });

  it('create surfaces unique violation as BAD_REQUEST SLUG_TAKEN', async () => {
    transactionImpl.mockImplementationOnce(async () => {
      const err = Object.assign(new Error('duplicate key value'), { code: '23505' });
      throw err;
    });
    const tool = forgeAdminProjectsTool(buildCtx());
    await expect(
      tool.handler({
        action: 'create',
        data: { slug: 'taken', name: 'X' },
      }),
    ).rejects.toThrow(/BAD_REQUEST: SLUG_TAKEN/);
  });

  it('archive without confirm:true throws BAD_REQUEST', async () => {
    const tool = forgeAdminProjectsTool(buildCtx());
    await expect(
      tool.handler({ action: 'archive', projectId: PROJECT_ID, confirm: false }),
    ).rejects.toThrow(/BAD_REQUEST: archive requires confirm/);
  });

  it('archive by a non-admin is refused', async () => {
    // caller is neither owner nor a member → loadDeviceProjectRole returns
    // not-admin; assertPrincipalIsAdmin throws before any delete.
    selectImpl.mockImplementationOnce(() => ({
      from: () => ({ where: () => ({ limit: () => Promise.resolve([{ ownerId: OTHER_OWNER_ID }]) }) }),
    }));
    // projectMembers lookup → no row
    selectImpl.mockImplementationOnce(() => ({
      from: () => ({ where: () => ({ limit: () => Promise.resolve([]) }) }),
    }));
    const tool = forgeAdminProjectsTool(buildCtx());
    await expect(
      tool.handler({ action: 'archive', projectId: PROJECT_ID, confirm: true }),
    ).rejects.toThrow(/FORBIDDEN/);
  });

  it('archive with in-flight sessions throws PROJECT_BUSY', async () => {
    mockOwnerLookup(OWNER_ID); // caller is owner → admin
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
    mockOwnerLookup(OWNER_ID); // caller is owner → admin
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
});
