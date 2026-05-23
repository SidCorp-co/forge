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
const updateImpl = vi.fn();
const transactionImpl = vi.fn();

vi.mock('../../db/client.js', () => ({
  db: {
    select: (...args: unknown[]) => selectImpl(...args),
    insert: (...args: unknown[]) => insertImpl(...args),
    update: (...args: unknown[]) => updateImpl(...args),
    transaction: (...args: unknown[]) => transactionImpl(...args),
  },
}));

const { forgeProjectsCreateTool, forgeProjectsListTool, forgeProjectsUpdateTool } = await import(
  './forge-projects.js'
);

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
  insertImpl.mockReset();
  updateImpl.mockReset();
  transactionImpl.mockReset();
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

function deviceCtx() {
  return {
    principal: { kind: 'device' as const, device: fakeDevice },
    device: fakeDevice,
    projectSlug: null,
  };
}

function patCtx(opts: {
  userId?: string;
  scopes?: readonly string[];
  projectIds?: readonly string[] | null;
}) {
  return {
    principal: {
      kind: 'pat' as const,
      userId: opts.userId ?? OWNER_ID,
      tokenId: 'token-id',
      scopes: opts.scopes ?? ['read', 'write'],
      projectIds: opts.projectIds ?? null,
    },
    device: fakeDevice,
    projectSlug: null,
  };
}

/**
 * Stub `db.transaction(fn)` for the create path. The factory's transaction
 * runs two inserts in order: (1) projects → returns the project row;
 * (2) projectMembers → returns nothing. We hand the factory a `tx` proxy
 * that dispenses two `insert()` shapes in that order.
 */
function mockCreateTransaction(returnedProject: Record<string, unknown>) {
  transactionImpl.mockImplementationOnce(async (fn: (tx: unknown) => unknown) => {
    let n = 0;
    const tx = {
      insert: () => {
        n++;
        if (n === 1) {
          return {
            values: () => ({
              returning: () => Promise.resolve([returnedProject]),
            }),
          };
        }
        return {
          values: () => Promise.resolve(undefined),
        };
      },
    };
    return fn(tx);
  });
}

describe('forge_projects.create', () => {
  const NEW_PROJECT_ID = '66666666-6666-4666-8666-666666666666';

  it('device principal creates project and receives apiKey back', async () => {
    mockCreateTransaction({
      id: NEW_PROJECT_ID,
      slug: 'my-proj',
      name: 'My Project',
      ownerId: OWNER_ID,
      apiKey: 'fk_abc123def456',
      createdAt: new Date(),
    });
    const tool = forgeProjectsCreateTool(deviceCtx());
    const res = (await tool.handler({ slug: 'my-proj', name: 'My Project' })) as {
      project: { id: string; slug: string; ownerId: string; apiKey: string };
    };
    expect(res.project.id).toBe(NEW_PROJECT_ID);
    expect(res.project.slug).toBe('my-proj');
    expect(res.project.ownerId).toBe(OWNER_ID);
    // apiKey MUST be returned — caller is the owner and needs it for widget
    // install / device pairing (matches REST POST /api/projects).
    expect(res.project.apiKey).toBe('fk_abc123def456');
  });

  it('PAT principal with write scope and null allowlist creates project', async () => {
    mockCreateTransaction({
      id: NEW_PROJECT_ID,
      slug: 'pat-proj',
      name: 'PAT Project',
      ownerId: OWNER_ID,
      apiKey: 'fk_xyz',
      createdAt: new Date(),
    });
    const tool = forgeProjectsCreateTool(patCtx({ scopes: ['read', 'write'] }));
    const res = (await tool.handler({ slug: 'pat-proj', name: 'PAT Project' })) as {
      project: { ownerId: string };
    };
    expect(res.project.ownerId).toBe(OWNER_ID);
    expect(transactionImpl).toHaveBeenCalledTimes(1);
  });

  it('PAT principal without write scope is refused with FORBIDDEN_SCOPE', async () => {
    const tool = forgeProjectsCreateTool(patCtx({ scopes: ['read'] }));
    await expect(tool.handler({ slug: 'no-write', name: 'X' })).rejects.toThrow(
      /FORBIDDEN_SCOPE: requires write scope/,
    );
    expect(transactionImpl).not.toHaveBeenCalled();
  });

  it('PAT principal with a projectIds allowlist is refused with FORBIDDEN_SCOPE', async () => {
    const tool = forgeProjectsCreateTool(
      patCtx({ scopes: ['read', 'write'], projectIds: [PROJECT_A] }),
    );
    await expect(tool.handler({ slug: 'scoped', name: 'X' })).rejects.toThrow(
      /FORBIDDEN_SCOPE: PAT with a projectIds allowlist cannot create new projects/,
    );
    expect(transactionImpl).not.toHaveBeenCalled();
  });

  it('unique-violation on slug constraint surfaces as BAD_REQUEST SLUG_TAKEN', async () => {
    // Real shape from drizzle-orm/postgres-js: the postgres-js driver puts
    // SQLSTATE + constraint_name on the inner pg error; Drizzle wraps it in
    // `{ query, params, cause }`. Mock that nesting so the test matches
    // production rather than a fictional flat `.code` shape.
    transactionImpl.mockImplementationOnce(async () => {
      throw Object.assign(new Error('Failed query: insert into "projects"'), {
        query: 'insert into "projects"...',
        params: [],
        cause: Object.assign(new Error('duplicate key value'), {
          code: '23505',
          constraint_name: 'projects_slug_unique',
        }),
      });
    });
    const tool = forgeProjectsCreateTool(deviceCtx());
    await expect(tool.handler({ slug: 'taken', name: 'X' })).rejects.toThrow(
      /BAD_REQUEST: SLUG_TAKEN/,
    );
  });

  it('unique-violation on a non-slug constraint rethrows as-is (no false SLUG_TAKEN)', async () => {
    // Simulates a future migration adding e.g. UNIQUE(owner_id, name), or
    // an apiKey collision. The handler must NOT lie about which constraint
    // failed — otherwise callers debug the wrong field.
    const collision = Object.assign(new Error('Failed query: insert into "projects"'), {
      query: 'insert into "projects"...',
      params: [],
      cause: Object.assign(new Error('duplicate key value'), {
        code: '23505',
        constraint_name: 'projects_owner_id_name_unique',
      }),
    });
    transactionImpl.mockImplementationOnce(async () => {
      throw collision;
    });
    const tool = forgeProjectsCreateTool(deviceCtx());
    await expect(
      tool.handler({ slug: 'unique-slug', name: 'taken-name' }),
    ).rejects.toBe(collision);
  });

  it('rejects invalid slug formats at the schema layer', async () => {
    const tool = forgeProjectsCreateTool(deviceCtx());
    await expect(tool.handler({ slug: 'Bad Slug!', name: 'X' })).rejects.toThrow();
    expect(transactionImpl).not.toHaveBeenCalled();
  });
});

describe('forge_projects.update', () => {
  /**
   * The owner-only gate runs two queries:
   *   1) select({ ownerId }) from projects — short-circuits when caller is
   *      the row's primary ownerId.
   *   2) select({ role }) from project_members — only when (1) doesn't match;
   *      `owner` role passes, anything else (incl. `admin`) is refused.
   */
  function mockOwnerLookup(ownerId: string | null) {
    selectImpl.mockImplementationOnce(() => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve(ownerId === null ? [] : [{ ownerId }]),
        }),
      }),
    }));
  }

  function mockMemberRoleLookup(role: string | null) {
    selectImpl.mockImplementationOnce(() => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve(role === null ? [] : [{ role }]),
        }),
      }),
    }));
  }

  function mockUpdateReturning(row: Record<string, unknown>) {
    updateImpl.mockImplementationOnce(() => ({
      set: () => ({
        where: () => ({
          returning: () => Promise.resolve([row]),
        }),
      }),
    }));
  }

  it('primary-owner applies patch and returns the updated row (no member lookup needed)', async () => {
    mockOwnerLookup(OWNER_ID);
    mockUpdateReturning({
      id: PROJECT_A,
      slug: 'a',
      name: 'A renamed',
      ownerId: OWNER_ID,
      description: null,
      repoPath: '/srv/a',
      baseBranch: 'main',
      productionBranch: null,
    });
    const tool = forgeProjectsUpdateTool(deviceCtx());
    const res = (await tool.handler({
      projectId: PROJECT_A,
      patch: { name: 'A renamed', repoPath: '/srv/a', baseBranch: 'main' },
    })) as { project: { name: string; repoPath: string } };
    expect(res.project.name).toBe('A renamed');
    expect(res.project.repoPath).toBe('/srv/a');
    // Sensitive REST-only fields must NOT appear in the response shape so a
    // future .returning() refactor that selects them can't ship silently.
    for (const k of ['apiKey', 'webhookSecret', 'agentConfig', 'previewDeploy', 'defaultDeviceId']) {
      expect(res.project).not.toHaveProperty(k);
    }
    // The owner-only short-circuit must skip the projectMembers lookup —
    // exactly one select call (the ownerId lookup).
    expect(selectImpl).toHaveBeenCalledTimes(1);
  });

  it('owner-role member (project has multiple owners) is accepted', async () => {
    mockOwnerLookup(OTHER_OWNER_ID);
    mockMemberRoleLookup('owner');
    mockUpdateReturning({
      id: PROJECT_A,
      slug: 'a',
      name: 'renamed by co-owner',
      ownerId: OTHER_OWNER_ID,
      description: null,
      repoPath: null,
      baseBranch: null,
      productionBranch: null,
    });
    const tool = forgeProjectsUpdateTool(deviceCtx());
    const res = (await tool.handler({
      projectId: PROJECT_A,
      patch: { name: 'renamed by co-owner' },
    })) as { project: { name: string } };
    expect(res.project.name).toBe('renamed by co-owner');
  });

  it('admin-role member is REFUSED with FORBIDDEN (matches REST owner-only PATCH)', async () => {
    // The fix for PR-128 finding #1 — pre-fix, admin members could mutate
    // settings via MCP even though REST PATCH /api/projects/:id requires
    // role==='owner'. Now MCP refuses too.
    mockOwnerLookup(OTHER_OWNER_ID);
    mockMemberRoleLookup('admin');
    const tool = forgeProjectsUpdateTool(deviceCtx());
    await expect(
      tool.handler({ projectId: PROJECT_A, patch: { name: 'no' } }),
    ).rejects.toThrow(/FORBIDDEN: requires project owner/);
    expect(updateImpl).not.toHaveBeenCalled();
  });

  it('member role (not owner) is refused with FORBIDDEN', async () => {
    mockOwnerLookup(OTHER_OWNER_ID);
    mockMemberRoleLookup('member');
    const tool = forgeProjectsUpdateTool(deviceCtx());
    await expect(
      tool.handler({ projectId: PROJECT_A, patch: { name: 'no' } }),
    ).rejects.toThrow(/FORBIDDEN: requires project owner/);
    expect(updateImpl).not.toHaveBeenCalled();
  });

  it('non-member device principal is refused with NOT_FOUND (no existence leak)', async () => {
    mockOwnerLookup(OTHER_OWNER_ID);
    mockMemberRoleLookup(null);
    const tool = forgeProjectsUpdateTool(deviceCtx());
    await expect(
      tool.handler({ projectId: PROJECT_A, patch: { name: 'no' } }),
    ).rejects.toThrow(/NOT_FOUND/);
    expect(updateImpl).not.toHaveBeenCalled();
  });

  it('non-existent project is refused with NOT_FOUND for both device and PAT', async () => {
    // Device path
    mockOwnerLookup(null);
    const deviceTool = forgeProjectsUpdateTool(deviceCtx());
    await expect(
      deviceTool.handler({ projectId: PROJECT_A, patch: { name: 'no' } }),
    ).rejects.toThrow(/NOT_FOUND/);

    // PAT path (also expects NOT_FOUND, not FORBIDDEN)
    mockOwnerLookup(null);
    const patTool = forgeProjectsUpdateTool(patCtx({ scopes: ['read', 'write'] }));
    await expect(
      patTool.handler({ projectId: PROJECT_A, patch: { name: 'no' } }),
    ).rejects.toThrow(/NOT_FOUND/);
    expect(updateImpl).not.toHaveBeenCalled();
  });

  it('PAT without write scope is refused before any DB lookup', async () => {
    const tool = forgeProjectsUpdateTool(patCtx({ scopes: ['read'] }));
    await expect(
      tool.handler({ projectId: PROJECT_A, patch: { name: 'no' } }),
    ).rejects.toThrow(/FORBIDDEN_SCOPE: requires write scope/);
    expect(selectImpl).not.toHaveBeenCalled();
    expect(updateImpl).not.toHaveBeenCalled();
  });

  it('PAT with allowlist miss is refused with NOT_FOUND without touching the DB', async () => {
    const tool = forgeProjectsUpdateTool(
      patCtx({ scopes: ['read', 'write'], projectIds: [PROJECT_B] }),
    );
    await expect(
      tool.handler({ projectId: PROJECT_A, patch: { name: 'no' } }),
    ).rejects.toThrow(/NOT_FOUND/);
    // Short-circuit invariant: a probing PAT must not see the latency of a
    // DB lookup leak project existence outside its allowlist.
    expect(selectImpl).not.toHaveBeenCalled();
    expect(updateImpl).not.toHaveBeenCalled();
  });

  it('empty patch is rejected by Zod refine (not by downstream SQL)', async () => {
    const tool = forgeProjectsUpdateTool(deviceCtx());
    // Pin the throw site: must be the schema refine, not a Drizzle SQL
    // error from set({}). If a future refactor breaks the refine, the
    // empty-updates SQL bug would re-emerge and this exact message would
    // disappear.
    await expect(
      tool.handler({ projectId: PROJECT_A, patch: {} }),
    ).rejects.toThrow(/patch must have at least one defined field/);
    expect(selectImpl).not.toHaveBeenCalled();
  });

  it('patch with only explicit-undefined values is rejected by refine (empty-SET guard)', async () => {
    // Zod v4 .strict() does NOT strip explicit-undefined values, so
    // `{name: undefined}` would pass `Object.keys.length > 0`. The refine
    // is now on Object.values to catch this.
    const tool = forgeProjectsUpdateTool(deviceCtx());
    await expect(
      tool.handler({
        projectId: PROJECT_A,
        patch: { name: undefined as unknown as string },
      }),
    ).rejects.toThrow(/patch must have at least one defined field/);
    expect(selectImpl).not.toHaveBeenCalled();
    expect(updateImpl).not.toHaveBeenCalled();
  });
});
