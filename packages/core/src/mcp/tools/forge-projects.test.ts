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
    select: (...args: unknown[]) => selectImpl(...args),
  },
}));

const { forgeProjectsListTool } = await import('./forge-projects.js');

const OWNER_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_OWNER_ID = '22222222-2222-4222-8222-222222222222';
const PROJECT_A = '33333333-3333-4333-8333-333333333333';
const PROJECT_B = '44444444-4444-4444-8444-444444444444';
const DEVICE_ID = '55555555-5555-4555-8555-555555555555';

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

beforeEach(() => {
  vi.clearAllMocks();
  selectImpl.mockReset();
});

function mockMeLookup(isCeo: boolean) {
  // db.select({...}).from(users).where(...).limit(1)
  selectImpl.mockImplementationOnce(() => ({
    from: () => ({
      where: () => ({
        limit: () => Promise.resolve([{ id: OWNER_ID, isCeo }]),
      }),
    }),
  }));
}

function mockOwnedQuery(rows: unknown[]) {
  // db.select({...}).from(projects).where(eq(projects.ownerId, owner))
  selectImpl.mockImplementationOnce(() => ({
    from: () => ({
      where: () => Promise.resolve(rows),
    }),
  }));
}

function mockMemberQuery(rows: unknown[]) {
  // db.select({...}).from(projectMembers).innerJoin(projects, ...).where(...)
  selectImpl.mockImplementationOnce(() => ({
    from: () => ({
      innerJoin: () => ({
        where: () => Promise.resolve(rows),
      }),
    }),
  }));
}

function mockCeoListAll(rows: unknown[]) {
  // db.select({...}).from(projects)  (no .where chained)
  selectImpl.mockImplementationOnce(() => ({
    from: () => Promise.resolve(rows),
  }));
}

describe('forge_projects.list', () => {
  it('non-CEO returns owned + member projects with correct role mapping', async () => {
    const tool = forgeProjectsListTool({
      principal: { kind: 'device', device: fakeDevice },
      device: fakeDevice,
      projectSlug: null,
    });
    mockMeLookup(false);
    mockOwnedQuery([{ id: PROJECT_A, slug: 'a', name: 'A', ownerId: OWNER_ID }]);
    mockMemberQuery([
      { id: PROJECT_B, slug: 'b', name: 'B', ownerId: OTHER_OWNER_ID, role: 'admin' },
    ]);

    const result = (await tool.handler({})) as {
      projects: Array<{ id: string; role: string }>;
    };
    expect(result.projects).toHaveLength(2);
    expect(result.projects.find((p) => p.id === PROJECT_A)?.role).toBe('owner');
    expect(result.projects.find((p) => p.id === PROJECT_B)?.role).toBe('admin');
  });

  it('member-row with role=member surfaces as member', async () => {
    const tool = forgeProjectsListTool({
      principal: { kind: 'device', device: fakeDevice },
      device: fakeDevice,
      projectSlug: null,
    });
    mockMeLookup(false);
    mockOwnedQuery([]);
    mockMemberQuery([
      { id: PROJECT_B, slug: 'b', name: 'B', ownerId: OTHER_OWNER_ID, role: 'member' },
    ]);

    const result = (await tool.handler({})) as { projects: Array<{ role: string }> };
    expect(result.projects[0]?.role).toBe('member');
  });

  it('owner with co-existing member row keeps role=owner and is not duplicated', async () => {
    const tool = forgeProjectsListTool({
      principal: { kind: 'device', device: fakeDevice },
      device: fakeDevice,
      projectSlug: null,
    });
    mockMeLookup(false);
    mockOwnedQuery([{ id: PROJECT_A, slug: 'a', name: 'A', ownerId: OWNER_ID }]);
    // The device owner happens to also have a projectMembers row on the
    // project they own (e.g. seeded on project create). It must NOT cause a
    // duplicate listing or downgrade the role.
    mockMemberQuery([
      { id: PROJECT_A, slug: 'a', name: 'A', ownerId: OWNER_ID, role: 'admin' },
    ]);

    const result = (await tool.handler({})) as {
      projects: Array<{ id: string; role: string }>;
    };
    expect(result.projects).toHaveLength(1);
    expect(result.projects[0]?.role).toBe('owner');
  });

  it('CEO sees all projects; role=owner when ownerId matches, else admin', async () => {
    const tool = forgeProjectsListTool({
      principal: { kind: 'device', device: fakeDevice },
      device: fakeDevice,
      projectSlug: null,
    });
    mockMeLookup(true);
    mockCeoListAll([
      { id: PROJECT_A, slug: 'a', name: 'A', ownerId: OWNER_ID },
      { id: PROJECT_B, slug: 'b', name: 'B', ownerId: OTHER_OWNER_ID },
    ]);

    const result = (await tool.handler({})) as {
      projects: Array<{ id: string; role: string }>;
    };
    expect(result.projects).toHaveLength(2);
    expect(result.projects.find((p) => p.id === PROJECT_A)?.role).toBe('owner');
    expect(result.projects.find((p) => p.id === PROJECT_B)?.role).toBe('admin');
  });

  it('PAT principal with projectIds allowlist filters output to allowed projects only (ISS-150)', async () => {
    const tool = forgeProjectsListTool({
      principal: {
        kind: 'pat',
        userId: OWNER_ID,
        tokenId: 'token-id',
        scopes: ['read'],
        projectIds: [PROJECT_A],
      },
      device: fakeDevice,
      projectSlug: null,
    });
    mockMeLookup(false);
    mockOwnedQuery([{ id: PROJECT_A, slug: 'a', name: 'A', ownerId: OWNER_ID }]);
    mockMemberQuery([
      { id: PROJECT_B, slug: 'b', name: 'B', ownerId: OTHER_OWNER_ID, role: 'member' },
    ]);

    const result = (await tool.handler({})) as {
      projects: Array<{ id: string }>;
    };
    // PROJECT_B is a real membership but NOT in the PAT's projectIds — must be filtered.
    expect(result.projects).toHaveLength(1);
    expect(result.projects[0]?.id).toBe(PROJECT_A);
  });

  it('PAT principal with null projectIds (global) sees everything the user can access', async () => {
    const tool = forgeProjectsListTool({
      principal: {
        kind: 'pat',
        userId: OWNER_ID,
        tokenId: 'token-id',
        scopes: ['read'],
        projectIds: null,
      },
      device: fakeDevice,
      projectSlug: null,
    });
    mockMeLookup(false);
    mockOwnedQuery([{ id: PROJECT_A, slug: 'a', name: 'A', ownerId: OWNER_ID }]);
    mockMemberQuery([
      { id: PROJECT_B, slug: 'b', name: 'B', ownerId: OTHER_OWNER_ID, role: 'member' },
    ]);

    const result = (await tool.handler({})) as { projects: unknown[] };
    expect(result.projects).toHaveLength(2);
  });

  it('PAT CEO with projectIds allowlist is still narrowed (ISS-150)', async () => {
    const tool = forgeProjectsListTool({
      principal: {
        kind: 'pat',
        userId: OWNER_ID,
        tokenId: 'token-id',
        scopes: ['read'],
        projectIds: [PROJECT_B],
      },
      device: fakeDevice,
      projectSlug: null,
    });
    mockMeLookup(true);
    mockCeoListAll([
      { id: PROJECT_A, slug: 'a', name: 'A', ownerId: OWNER_ID },
      { id: PROJECT_B, slug: 'b', name: 'B', ownerId: OTHER_OWNER_ID },
    ]);

    const result = (await tool.handler({})) as { projects: Array<{ id: string }> };
    expect(result.projects).toHaveLength(1);
    expect(result.projects[0]?.id).toBe(PROJECT_B);
  });

  it('handles missing user row gracefully (treated as non-CEO)', async () => {
    const tool = forgeProjectsListTool({
      principal: { kind: 'device', device: fakeDevice },
      device: fakeDevice,
      projectSlug: null,
    });
    selectImpl.mockImplementationOnce(() => ({
      from: () => ({
        where: () => ({ limit: () => Promise.resolve([]) }),
      }),
    }));
    mockOwnedQuery([]);
    mockMemberQuery([]);

    const result = (await tool.handler({})) as { projects: unknown[] };
    expect(result.projects).toEqual([]);
  });
});
