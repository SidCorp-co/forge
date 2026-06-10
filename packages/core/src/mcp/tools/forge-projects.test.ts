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
const updateImpl = vi.fn();
const deleteImpl = vi.fn();
const transactionImpl = vi.fn();

vi.mock('../../db/client.js', () => ({
  db: {
    select: (...args: unknown[]) => selectImpl(...args),
    selectDistinct: (...args: unknown[]) => selectDistinctImpl(...args),
    insert: (...args: unknown[]) => insertImpl(...args),
    update: (...args: unknown[]) => updateImpl(...args),
    delete: (...args: unknown[]) => deleteImpl(...args),
    transaction: (...args: unknown[]) => transactionImpl(...args),
  },
}));

const {
  forgeProjectsArchiveTool,
  forgeProjectsCreateTool,
  forgeProjectsGetTool,
  forgeProjectsListTool,
  forgeProjectsUpdateTool,
} = await import('./forge-projects.js');

const OWNER_ID = '11111111-1111-4111-8111-111111111111';
const PROJECT_A = '33333333-3333-4333-8333-333333333333';
const PROJECT_B = '44444444-4444-4444-8444-444444444444';
const DEVICE_ID = '55555555-5555-4555-8555-555555555555';
const ORG_ID = '77777777-7777-4777-8777-777777777777';

const fakeDevice = {
  id: DEVICE_ID,
  ownerId: OWNER_ID,
  name: 'fake',
  platform: 'linux' as const,
  agentVersion: null,
  machineId: null,
  gitCredentialRef: null,
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
  selectDistinctImpl.mockReset();
  insertImpl.mockReset();
  updateImpl.mockReset();
  deleteImpl.mockReset();
  transactionImpl.mockReset();
});

/**
 * Generic thenable Drizzle-chain mock: every builder method returns the chain
 * itself and awaiting any point in the chain resolves to `rows`. Covers both
 * `...where(...)` (awaited directly) and `...where(...).limit(1)` shapes,
 * including the org-authz single query `from(projects).leftJoin().leftJoin()
 * .where().limit(1)` (lib/authz.ts effectiveProjectRole).
 */
function chainOnce(impl: ReturnType<typeof vi.fn>, rows: unknown[]) {
  // biome-ignore lint/suspicious/noExplicitAny: chainable mock proxy
  const chain: any = {};
  for (const m of ['from', 'leftJoin', 'innerJoin', 'where', 'orderBy', 'limit']) {
    chain[m] = () => chain;
  }
  // biome-ignore lint/suspicious/noThenProperty: drizzle chains resolve via await
  // biome-ignore lint/suspicious/noExplicitAny: thenable bridge
  chain.then = (resolve: any, reject: any) => Promise.resolve(rows).then(resolve, reject);
  impl.mockImplementationOnce(() => chain);
}

/** loadVisibleProjectIds — db.selectDistinct({id}).from(projects).leftJoin x2.where(). */
function mockVisibleIds(ids: string[]) {
  chainOnce(
    selectDistinctImpl,
    ids.map((id) => ({ id })),
  );
}

/** Any plain db.select(...) in handler order. */
function mockSelect(rows: unknown[]) {
  chainOnce(selectImpl, rows);
}

/**
 * effectiveProjectRole (lib/authz.ts) — ONE select with two leftJoins
 * returning [{ orgId, memberRole, orgRole }]. Pass `null` to simulate a
 * missing project (empty result).
 */
function mockAccess(
  access: { memberRole: string | null; orgRole: string | null } | null,
) {
  mockSelect(access === null ? [] : [{ orgId: ORG_ID, ...access }]);
}

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

describe('forge_projects.list', () => {
  it('returns visible projects with effective (org-aware) role mapping', async () => {
    const tool = forgeProjectsListTool(deviceCtx());
    mockVisibleIds([PROJECT_A, PROJECT_B]);
    mockSelect([
      { id: PROJECT_A, slug: 'a', name: 'A', orgId: ORG_ID },
      { id: PROJECT_B, slug: 'b', name: 'B', orgId: ORG_ID },
    ]);
    // per-project effectiveProjectRole, in row order:
    mockAccess({ memberRole: null, orgRole: 'owner' }); // org owner → implicit admin
    mockAccess({ memberRole: 'member', orgRole: null }); // explicit member row

    const result = (await tool.handler({})) as {
      projects: Array<{ id: string; orgId: string; role: string }>;
    };
    expect(result.projects).toHaveLength(2);
    expect(result.projects.find((p) => p.id === PROJECT_A)?.role).toBe('admin');
    expect(result.projects.find((p) => p.id === PROJECT_B)?.role).toBe('member');
    expect(result.projects[0]?.orgId).toBe(ORG_ID);
  });

  it('viewer-role member surfaces as viewer', async () => {
    const tool = forgeProjectsListTool(deviceCtx());
    mockVisibleIds([PROJECT_B]);
    mockSelect([{ id: PROJECT_B, slug: 'b', name: 'B', orgId: ORG_ID }]);
    mockAccess({ memberRole: 'viewer', orgRole: null });

    const result = (await tool.handler({})) as { projects: Array<{ role: string }> };
    expect(result.projects[0]?.role).toBe('viewer');
  });

  it('explicit admin row + org owner does not duplicate and stays admin', async () => {
    const tool = forgeProjectsListTool(deviceCtx());
    mockVisibleIds([PROJECT_A]);
    mockSelect([{ id: PROJECT_A, slug: 'a', name: 'A', orgId: ORG_ID }]);
    mockAccess({ memberRole: 'admin', orgRole: 'owner' });

    const result = (await tool.handler({})) as {
      projects: Array<{ id: string; role: string }>;
    };
    expect(result.projects).toHaveLength(1);
    expect(result.projects[0]?.role).toBe('admin');
  });

  it('PAT principal with projectIds allowlist filters output to allowed projects only (ISS-150)', async () => {
    const tool = forgeProjectsListTool(patCtx({ scopes: ['read'], projectIds: [PROJECT_A] }));
    // user can see both projects, allowlist narrows to PROJECT_A
    mockVisibleIds([PROJECT_A, PROJECT_B]);
    mockSelect([{ id: PROJECT_A, slug: 'a', name: 'A', orgId: ORG_ID }]);
    mockAccess({ memberRole: 'member', orgRole: null });

    const result = (await tool.handler({})) as {
      projects: Array<{ id: string }>;
    };
    expect(result.projects).toHaveLength(1);
    expect(result.projects[0]?.id).toBe(PROJECT_A);
  });

  it('PAT principal with null projectIds (global) sees everything the user can access', async () => {
    const tool = forgeProjectsListTool(patCtx({ scopes: ['read'], projectIds: null }));
    mockVisibleIds([PROJECT_A, PROJECT_B]);
    mockSelect([
      { id: PROJECT_A, slug: 'a', name: 'A', orgId: ORG_ID },
      { id: PROJECT_B, slug: 'b', name: 'B', orgId: ORG_ID },
    ]);
    mockAccess({ memberRole: 'admin', orgRole: null });
    mockAccess({ memberRole: 'member', orgRole: null });

    const result = (await tool.handler({})) as { projects: unknown[] };
    expect(result.projects).toHaveLength(2);
  });

  it('returns [] when the user can see no projects', async () => {
    const tool = forgeProjectsListTool(deviceCtx());
    mockVisibleIds([]);

    const result = (await tool.handler({})) as { projects: unknown[] };
    expect(result.projects).toEqual([]);
    expect(selectImpl).not.toHaveBeenCalled();
  });
});

/**
 * Stub `db.transaction(fn)` for the create path. The factory's transaction
 * runs two inserts in order: (1) projects → returns the project row;
 * (2) projectMembers (role 'admin') → returns nothing. We hand the factory a
 * `tx` proxy that dispenses two `insert()` shapes in that order and captures
 * the projectMembers values for assertion.
 */
function mockCreateTransaction(
  returnedProject: Record<string, unknown>,
  captured: { memberValues?: Record<string, unknown> } = {},
) {
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
          values: (v: Record<string, unknown>) => {
            captured.memberValues = v;
            return Promise.resolve(undefined);
          },
        };
      },
    };
    return fn(tx);
  });
}

describe('forge_projects.create', () => {
  const NEW_PROJECT_ID = '66666666-6666-4666-8666-666666666666';

  it('device principal creates project in personal org and receives apiKey back', async () => {
    // personal-org resolution: select organizations where createdBy + isPersonal
    mockSelect([{ id: ORG_ID }]);
    const captured: { memberValues?: Record<string, unknown> } = {};
    mockCreateTransaction(
      {
        id: NEW_PROJECT_ID,
        slug: 'my-proj',
        name: 'My Project',
        orgId: ORG_ID,
        createdBy: OWNER_ID,
        apiKey: 'fk_abc123def456',
        createdAt: new Date(),
      },
      captured,
    );
    const tool = forgeProjectsCreateTool(deviceCtx());
    const res = (await tool.handler({ slug: 'my-proj', name: 'My Project' })) as {
      project: { id: string; slug: string; orgId: string; createdBy: string; apiKey: string };
    };
    expect(res.project.id).toBe(NEW_PROJECT_ID);
    expect(res.project.slug).toBe('my-proj');
    expect(res.project.orgId).toBe(ORG_ID);
    expect(res.project.createdBy).toBe(OWNER_ID);
    // apiKey MUST be returned — caller needs it for widget install / device
    // pairing (matches REST POST /api/projects).
    expect(res.project.apiKey).toBe('fk_abc123def456');
    // creator is seeded as a project ADMIN (no 'owner' role anymore)
    expect(captured.memberValues).toMatchObject({
      userId: OWNER_ID,
      projectId: NEW_PROJECT_ID,
      role: 'admin',
    });
  });

  it('explicit orgId requires org membership — non-member is refused NOT_FOUND', async () => {
    // loadOrgRole → no row
    mockSelect([]);
    const tool = forgeProjectsCreateTool(deviceCtx());
    await expect(
      tool.handler({ slug: 'org-proj', name: 'X', orgId: ORG_ID }),
    ).rejects.toThrow(/NOT_FOUND: org not found or not accessible/);
    expect(transactionImpl).not.toHaveBeenCalled();
  });

  it('explicit orgId with org membership creates the project in that org', async () => {
    mockSelect([{ role: 'member' }]); // loadOrgRole
    mockCreateTransaction({
      id: NEW_PROJECT_ID,
      slug: 'org-proj',
      name: 'Org Project',
      orgId: ORG_ID,
      createdBy: OWNER_ID,
      apiKey: 'fk_org',
      createdAt: new Date(),
    });
    const tool = forgeProjectsCreateTool(deviceCtx());
    const res = (await tool.handler({
      slug: 'org-proj',
      name: 'Org Project',
      orgId: ORG_ID,
    })) as { project: { orgId: string } };
    expect(res.project.orgId).toBe(ORG_ID);
  });

  it('PAT principal with write scope and null allowlist creates project', async () => {
    mockSelect([{ id: ORG_ID }]); // personal org
    mockCreateTransaction({
      id: NEW_PROJECT_ID,
      slug: 'pat-proj',
      name: 'PAT Project',
      orgId: ORG_ID,
      createdBy: OWNER_ID,
      apiKey: 'fk_xyz',
      createdAt: new Date(),
    });
    const tool = forgeProjectsCreateTool(patCtx({ scopes: ['read', 'write'] }));
    const res = (await tool.handler({ slug: 'pat-proj', name: 'PAT Project' })) as {
      project: { createdBy: string };
    };
    expect(res.project.createdBy).toBe(OWNER_ID);
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
    mockSelect([{ id: ORG_ID }]); // personal org
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
    // Simulates a future migration adding e.g. UNIQUE(org_id, name), or
    // an apiKey collision. The handler must NOT lie about which constraint
    // failed — otherwise callers debug the wrong field.
    mockSelect([{ id: ORG_ID }]); // personal org
    const collision = Object.assign(new Error('Failed query: insert into "projects"'), {
      query: 'insert into "projects"...',
      params: [],
      cause: Object.assign(new Error('duplicate key value'), {
        code: '23505',
        constraint_name: 'projects_org_id_name_unique',
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
   * The gate is ONE authz query (effectiveProjectRole) followed by an
   * org-tier check: org owner/admin on the project's org may update; a
   * merely-invited project admin may NOT.
   */
  function mockUpdateReturning(row: Record<string, unknown>) {
    updateImpl.mockImplementationOnce(() => ({
      set: () => ({
        where: () => ({
          returning: () => Promise.resolve([row]),
        }),
      }),
    }));
  }

  it('org owner applies patch and returns the updated row', async () => {
    mockAccess({ memberRole: null, orgRole: 'owner' });
    mockUpdateReturning({
      id: PROJECT_A,
      slug: 'a',
      name: 'A renamed',
      orgId: ORG_ID,
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
    // exactly one select — the single org-aware authz query.
    expect(selectImpl).toHaveBeenCalledTimes(1);
  });

  it('org admin (non-owner) is accepted', async () => {
    mockAccess({ memberRole: null, orgRole: 'admin' });
    mockUpdateReturning({
      id: PROJECT_A,
      slug: 'a',
      name: 'renamed by org admin',
      orgId: ORG_ID,
      description: null,
      repoPath: null,
      baseBranch: null,
      productionBranch: null,
    });
    const tool = forgeProjectsUpdateTool(deviceCtx());
    const res = (await tool.handler({
      projectId: PROJECT_A,
      patch: { name: 'renamed by org admin' },
    })) as { project: { name: string } };
    expect(res.project.name).toBe('renamed by org admin');
  });

  it('project-admin without org admin is REFUSED with FORBIDDEN (org gate)', async () => {
    // An invited project admin can manage members/labels but must not
    // mutate project settings — only org owner/admin can.
    mockAccess({ memberRole: 'admin', orgRole: null });
    const tool = forgeProjectsUpdateTool(deviceCtx());
    await expect(
      tool.handler({ projectId: PROJECT_A, patch: { name: 'no' } }),
    ).rejects.toThrow(/FORBIDDEN: requires org admin \(project admin role is insufficient\)/);
    expect(updateImpl).not.toHaveBeenCalled();
  });

  it('member role is refused with FORBIDDEN', async () => {
    mockAccess({ memberRole: 'member', orgRole: 'member' });
    const tool = forgeProjectsUpdateTool(deviceCtx());
    await expect(
      tool.handler({ projectId: PROJECT_A, patch: { name: 'no' } }),
    ).rejects.toThrow(/FORBIDDEN: requires org admin/);
    expect(updateImpl).not.toHaveBeenCalled();
  });

  it('non-member device principal is refused with NOT_FOUND (no existence leak)', async () => {
    mockAccess({ memberRole: null, orgRole: null });
    const tool = forgeProjectsUpdateTool(deviceCtx());
    await expect(
      tool.handler({ projectId: PROJECT_A, patch: { name: 'no' } }),
    ).rejects.toThrow(/NOT_FOUND/);
    expect(updateImpl).not.toHaveBeenCalled();
  });

  it('non-existent project is refused with NOT_FOUND for both device and PAT', async () => {
    // Device path
    mockAccess(null);
    const deviceTool = forgeProjectsUpdateTool(deviceCtx());
    await expect(
      deviceTool.handler({ projectId: PROJECT_A, patch: { name: 'no' } }),
    ).rejects.toThrow(/NOT_FOUND/);

    // PAT path (also expects NOT_FOUND, not FORBIDDEN)
    mockAccess(null);
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

describe('forge_projects.get', () => {
  /**
   * Handler issues queries in this fixed order:
   *   1. SELECT project row (always)
   *   2. effectiveProjectRole — single org-aware authz select; a null
   *      effective role → NOT_FOUND.
   */
  const CREATED_AT = new Date('2026-05-25T00:00:00.000Z');

  const FULL_PROJECT_ROW = {
    id: PROJECT_A,
    slug: 'a',
    name: 'A',
    description: 'desc',
    orgId: ORG_ID,
    createdBy: OWNER_ID,
    repoPath: '/srv/a',
    baseBranch: 'main',
    productionBranch: 'main',
    defaultDeviceId: DEVICE_ID,
    previewDeploy: {
      stagingUrl: 'https://stg.example.com',
      stagingApiUrl: 'https://api.stg.example.com',
      testingUrls: ['https://test.example.com'],
      testCredentials: [{ label: 'qa', username: 'qa@x', password: 'p4ss' }],
    },
    createdAt: CREATED_AT,
  };

  function mockProjectSelect(row: unknown | null) {
    mockSelect(row === null ? [] : [row]);
  }

  it('org owner reads project — effective role admin, full shape returned', async () => {
    mockProjectSelect(FULL_PROJECT_ROW);
    mockAccess({ memberRole: null, orgRole: 'owner' });
    const tool = forgeProjectsGetTool(deviceCtx());
    const res = (await tool.handler({ projectId: PROJECT_A })) as {
      project: Record<string, unknown>;
    };
    expect(res.project.role).toBe('admin');
    expect(res.project.id).toBe(PROJECT_A);
    expect(res.project.orgId).toBe(ORG_ID);
    expect(res.project.createdBy).toBe(OWNER_ID);
    expect(res.project.repoPath).toBe('/srv/a');
    expect(res.project.defaultDeviceId).toBe(DEVICE_ID);
    expect(selectImpl).toHaveBeenCalledTimes(2);
  });

  it('admin-role member reads project', async () => {
    mockProjectSelect(FULL_PROJECT_ROW);
    mockAccess({ memberRole: 'admin', orgRole: null });
    const tool = forgeProjectsGetTool(deviceCtx());
    const res = (await tool.handler({ projectId: PROJECT_A })) as {
      project: { role: string };
    };
    expect(res.project.role).toBe('admin');
    expect(selectImpl).toHaveBeenCalledTimes(2);
  });

  it('member-role member reads project', async () => {
    mockProjectSelect(FULL_PROJECT_ROW);
    mockAccess({ memberRole: 'member', orgRole: null });
    const tool = forgeProjectsGetTool(deviceCtx());
    const res = (await tool.handler({ projectId: PROJECT_A })) as {
      project: { role: string };
    };
    expect(res.project.role).toBe('member');
  });

  it('viewer-role member reads project', async () => {
    mockProjectSelect(FULL_PROJECT_ROW);
    mockAccess({ memberRole: 'viewer', orgRole: null });
    const tool = forgeProjectsGetTool(deviceCtx());
    const res = (await tool.handler({ projectId: PROJECT_A })) as {
      project: { role: string };
    };
    expect(res.project.role).toBe('viewer');
  });

  it('non-member returns NOT_FOUND (no existence leak)', async () => {
    mockProjectSelect(FULL_PROJECT_ROW);
    mockAccess({ memberRole: null, orgRole: null });
    const tool = forgeProjectsGetTool(deviceCtx());
    await expect(tool.handler({ projectId: PROJECT_A })).rejects.toThrow(
      /NOT_FOUND: project not found or not accessible/,
    );
  });

  it('plain org member (no project row) returns NOT_FOUND — org member derives nothing', async () => {
    mockProjectSelect(FULL_PROJECT_ROW);
    mockAccess({ memberRole: null, orgRole: 'member' });
    const tool = forgeProjectsGetTool(deviceCtx());
    await expect(tool.handler({ projectId: PROJECT_A })).rejects.toThrow(
      /NOT_FOUND: project not found or not accessible/,
    );
  });

  it('non-existent project returns NOT_FOUND', async () => {
    mockProjectSelect(null);
    const tool = forgeProjectsGetTool(deviceCtx());
    await expect(tool.handler({ projectId: PROJECT_A })).rejects.toThrow(
      /NOT_FOUND/,
    );
  });

  it('PAT without read scope is refused with FORBIDDEN_SCOPE before any DB lookup', async () => {
    const tool = forgeProjectsGetTool(patCtx({ scopes: ['write'] }));
    await expect(tool.handler({ projectId: PROJECT_A })).rejects.toThrow(
      /FORBIDDEN_SCOPE: requires read scope/,
    );
    expect(selectImpl).not.toHaveBeenCalled();
  });

  it('PAT with allowlist miss returns NOT_FOUND without touching DB', async () => {
    const tool = forgeProjectsGetTool(
      patCtx({ scopes: ['read'], projectIds: [PROJECT_B] }),
    );
    await expect(tool.handler({ projectId: PROJECT_A })).rejects.toThrow(
      /NOT_FOUND/,
    );
    expect(selectImpl).not.toHaveBeenCalled();
  });

  it('response shape excludes sensitive fields (agentConfig, webhookSecret, apiKey)', async () => {
    // Simulate a project row where the SELECT happened to leak extra fields
    // (defense-in-depth — the handler must drop anything not in the locked
    // shape rather than spreading the row).
    mockProjectSelect({
      ...FULL_PROJECT_ROW,
      agentConfig: { mcpServers: { secret: 'x' } },
      webhookSecret: 'wh',
      apiKey: 'fk_secret',
    });
    mockAccess({ memberRole: 'admin', orgRole: null });
    const tool = forgeProjectsGetTool(deviceCtx());
    const res = (await tool.handler({ projectId: PROJECT_A })) as {
      project: Record<string, unknown>;
    };
    const keys = Object.keys(res.project).sort();
    expect(keys).toEqual(
      [
        'baseBranch',
        'createdAt',
        'createdBy',
        'defaultDeviceId',
        'description',
        'id',
        'name',
        'orgId',
        'previewDeploy',
        'productionBranch',
        'repoPath',
        'role',
        'slug',
      ].sort(),
    );
    expect(res.project).not.toHaveProperty('agentConfig');
    expect(res.project).not.toHaveProperty('webhookSecret');
    expect(res.project).not.toHaveProperty('apiKey');
  });

  it('previewDeploy=null returns normalized defaults instead of crashing', async () => {
    mockProjectSelect({ ...FULL_PROJECT_ROW, previewDeploy: null });
    mockAccess({ memberRole: 'member', orgRole: null });
    const tool = forgeProjectsGetTool(deviceCtx());
    const res = (await tool.handler({ projectId: PROJECT_A })) as {
      project: { previewDeploy: Record<string, unknown> };
    };
    expect(res.project.previewDeploy).toEqual({
      stagingUrl: null,
      stagingApiUrl: null,
      testingUrls: [],
      testCredentials: [],
    });
  });

  it('rejects missing projectId with schema error', async () => {
    const tool = forgeProjectsGetTool(deviceCtx());
    await expect(tool.handler({} as never)).rejects.toThrow();
    expect(selectImpl).not.toHaveBeenCalled();
  });

  it('rejects non-uuid projectId with schema error', async () => {
    const tool = forgeProjectsGetTool(deviceCtx());
    await expect(tool.handler({ projectId: 'not-a-uuid' })).rejects.toThrow();
    expect(selectImpl).not.toHaveBeenCalled();
  });
});

describe('forge_projects.archive', () => {
  // Query order on the happy path:
  //   1. effectiveProjectRole via assertPrincipalIsAdmin (effective admin gate)
  //   2. effectiveProjectRole again for the org-tier gate (org owner/admin)
  //   3. agentSessions count
  //   4. delete().where().returning()

  it('without confirm:true throws BAD_REQUEST', async () => {
    const tool = forgeProjectsArchiveTool(deviceCtx());
    await expect(
      tool.handler({ projectId: PROJECT_A, confirm: false }),
    ).rejects.toThrow(/BAD_REQUEST: archive requires confirm/);
  });

  it('a read-only PAT is refused with FORBIDDEN_SCOPE (parity with create/update)', async () => {
    const tool = forgeProjectsArchiveTool(patCtx({ scopes: ['read'] }));
    await expect(
      tool.handler({ projectId: PROJECT_A, confirm: true }),
    ).rejects.toThrow(/FORBIDDEN_SCOPE: requires write scope/);
    // refused before any DB access
    expect(selectImpl).not.toHaveBeenCalled();
  });

  it('a PAT lacking the admin scope is refused with FORBIDDEN', async () => {
    const tool = forgeProjectsArchiveTool(patCtx({ scopes: ['read', 'write'] }));
    await expect(
      tool.handler({ projectId: PROJECT_A, confirm: true }),
    ).rejects.toThrow(/FORBIDDEN: this token lacks the admin scope/);
    // the scope gate fires before the role lookup
    expect(selectImpl).not.toHaveBeenCalled();
    expect(deleteImpl).not.toHaveBeenCalled();
  });

  it('by a non-admin member is refused', async () => {
    // member-but-not-admin → assertPrincipalIsAdmin throws before any delete.
    mockAccess({ memberRole: 'member', orgRole: null });
    const tool = forgeProjectsArchiveTool(deviceCtx());
    await expect(
      tool.handler({ projectId: PROJECT_A, confirm: true }),
    ).rejects.toThrow(/FORBIDDEN: requires project admin access/);
    expect(deleteImpl).not.toHaveBeenCalled();
  });

  it('project-admin without org admin is refused (org-tier gate)', async () => {
    mockAccess({ memberRole: 'admin', orgRole: null }); // passes effective-admin gate
    mockAccess({ memberRole: 'admin', orgRole: null }); // fails org gate
    const tool = forgeProjectsArchiveTool(deviceCtx());
    await expect(
      tool.handler({ projectId: PROJECT_A, confirm: true }),
    ).rejects.toThrow(/FORBIDDEN: requires org admin on the project/);
    expect(deleteImpl).not.toHaveBeenCalled();
  });

  it('with in-flight sessions throws PROJECT_BUSY', async () => {
    mockAccess({ memberRole: null, orgRole: 'owner' }); // effective admin
    mockAccess({ memberRole: null, orgRole: 'owner' }); // org gate
    mockSelect([{ active: 2 }]);
    const tool = forgeProjectsArchiveTool(deviceCtx());
    await expect(
      tool.handler({ projectId: PROJECT_A, confirm: true }),
    ).rejects.toThrow(/PROJECT_BUSY/);
  });

  it('happy path deletes and returns archived:true', async () => {
    mockAccess({ memberRole: null, orgRole: 'admin' }); // effective admin
    mockAccess({ memberRole: null, orgRole: 'admin' }); // org gate
    mockSelect([{ active: 0 }]);
    deleteImpl.mockImplementationOnce(() => ({
      where: () => ({
        returning: () => Promise.resolve([{ id: PROJECT_A }]),
      }),
    }));
    const tool = forgeProjectsArchiveTool(deviceCtx());
    const res = (await tool.handler({
      projectId: PROJECT_A,
      confirm: true,
    })) as { archived: boolean };
    expect(res.archived).toBe(true);
  });
});
