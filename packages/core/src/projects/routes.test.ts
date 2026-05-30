import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_SECRET = 'test-secret-at-least-32-chars-long-abcdef';

vi.mock('../config/env.js', () => ({
  env: { JWT_SECRET: TEST_SECRET, NODE_ENV: 'test' },
}));

// Verified-email lookup (from assertEmailVerified) is the first select call
// every authenticated test makes. We queue results FIFO via selectLimit.
const selectLimit = vi.fn();
const selectWhere = vi.fn(() => ({ limit: selectLimit }));
const selectOn = vi.fn(() => ({ where: selectWhere }));
const innerJoin = vi.fn(() => ({ on: selectOn, where: selectWhere }));
const selectFrom = vi.fn(() => ({
  where: selectWhere,
  innerJoin,
  // chained without limit/where (e.g. project_members for /:id detail)
}));

const txInsertProjectReturning = vi.fn();
const txInsertProjectValues = vi.fn(() => ({ returning: txInsertProjectReturning }));
const txInsertMembersValues = vi.fn(async () => undefined);
const txInsertProject = vi.fn(() => ({ values: txInsertProjectValues }));
const txInsertMembers = vi.fn(() => ({ values: txInsertMembersValues }));

const txInsert = vi.fn();

const transaction = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
  const tx = { insert: txInsert };
  return fn(tx);
});

const updateReturning = vi.fn();
const updateWhere = vi.fn(() => ({ returning: updateReturning }));
const updateSet = vi.fn(() => ({ where: updateWhere }));
const dbUpdate = vi.fn(() => ({ set: updateSet }));

const deleteWhere = vi.fn(async () => undefined);
const dbDelete = vi.fn(() => ({ where: deleteWhere }));

const insertOnConflict = vi.fn(async () => undefined);
const insertReturning = vi.fn();
const insertOnConflictDoUpdate = vi.fn(() => ({ returning: insertReturning }));
const insertValues = vi.fn(() => ({
  onConflictDoNothing: insertOnConflict,
  onConflictDoUpdate: insertOnConflictDoUpdate,
  returning: insertReturning,
}));
const dbInsert = vi.fn(() => ({ values: insertValues }));

vi.mock('../db/client.js', () => ({
  db: {
    select: vi.fn(() => ({ from: selectFrom })),
    transaction,
    update: dbUpdate,
    delete: dbDelete,
    insert: dbInsert,
  },
}));

const { projectRoutes } = await import('./routes.js');
const { signUserToken } = await import('../auth/jwt.js');
const { errorHandler } = await import('../middleware/error.js');
const { requestId } = await import('../middleware/request-id.js');

function buildApp() {
  const app = new Hono<{ Variables: import('../middleware/request-id.js').RequestIdVars }>();
  app.use('*', requestId());
  app.route('/api/projects', projectRoutes);
  app.onError(errorHandler);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  selectLimit.mockReset();
  selectWhere.mockClear();
  innerJoin.mockClear();
  txInsertProjectReturning.mockReset();
  updateReturning.mockReset();
  deleteWhere.mockClear();
  insertValues.mockClear();
  insertOnConflict.mockClear();
  insertOnConflictDoUpdate.mockClear();
  insertReturning.mockReset();
  let callIdx = 0;
  txInsert.mockImplementation(() => {
    const idx = callIdx++;
    return idx === 0 ? txInsertProject() : txInsertMembers();
  });
});

function req(path: string, init: RequestInit & { token?: string } = {}) {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...((init.headers as Record<string, string>) ?? {}),
  };
  if (init.token) headers.authorization = `Bearer ${init.token}`;
  const { token: _t, ...rest } = init;
  return buildApp().request(`/api/projects${path}`, { ...rest, headers });
}

function post(body: unknown, token?: string) {
  return req('', { method: 'POST', body: JSON.stringify(body), token });
}

describe('POST /api/projects', () => {
  it('401 UNAUTHENTICATED without a token', async () => {
    const res = await post({ slug: 'my-proj', name: 'My Project' });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('UNAUTHENTICATED');
  });

  it('403 EMAIL_NOT_VERIFIED when user is not verified', async () => {
    const token = await signUserToken('uuid-unverified');
    selectLimit.mockResolvedValueOnce([{ emailVerifiedAt: null }]);

    const res = await post({ slug: 'my-proj', name: 'My Project' }, token);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('EMAIL_NOT_VERIFIED');
    expect(transaction).not.toHaveBeenCalled();
  });

  it('201 with created project + owner member row for verified user', async () => {
    const token = await signUserToken('uuid-owner');
    selectLimit.mockResolvedValueOnce([{ emailVerifiedAt: new Date() }]);
    const createdAt = new Date('2026-04-23T00:00:00Z');
    txInsertProjectReturning.mockResolvedValueOnce([
      {
        id: 'proj-1',
        slug: 'my-proj',
        name: 'My Project',
        ownerId: 'uuid-owner',
        createdAt,
      },
    ]);

    const res = await post({ slug: 'my-proj', name: 'My Project' }, token);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; slug: string; ownerId: string };
    expect(body).toMatchObject({ id: 'proj-1', slug: 'my-proj', ownerId: 'uuid-owner' });

    expect(txInsertProjectValues).toHaveBeenCalledWith(
      expect.objectContaining({
        slug: 'my-proj',
        name: 'My Project',
        ownerId: 'uuid-owner',
        apiKey: expect.stringMatching(/^fk_[0-9a-f]{48}$/),
        // ISS-274 — branch columns are defaulted at create time so the
        // resolver never surfaces a null-base misconfig for new projects.
        baseBranch: 'main',
        productionBranch: 'main',
      }),
    );
    expect(txInsertMembersValues).toHaveBeenCalledWith({
      userId: 'uuid-owner',
      projectId: 'proj-1',
      role: 'owner',
    });
  });

  it('400 BAD_REQUEST on invalid slug', async () => {
    const token = await signUserToken('uuid-owner');
    selectLimit.mockResolvedValueOnce([{ emailVerifiedAt: new Date() }]);

    const res = await post({ slug: 'UpperCase!', name: 'x' }, token);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('BAD_REQUEST');
    expect(transaction).not.toHaveBeenCalled();
  });

  it('409 SLUG_TAKEN on unique violation', async () => {
    const token = await signUserToken('uuid-owner');
    selectLimit.mockResolvedValueOnce([{ emailVerifiedAt: new Date() }]);
    const pgErr = Object.assign(new Error('duplicate key'), { code: '23505' });
    txInsertProjectReturning.mockRejectedValueOnce(pgErr);

    const res = await post({ slug: 'taken', name: 'X' }, token);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('SLUG_TAKEN');
  });
});

describe('GET /api/projects', () => {
  it('returns the joined membership rows for the user', async () => {
    const token = await signUserToken('uuid-user');
    // 1) verified-email lookup goes through select().from().where().limit().
    //    selectWhere's default returns { limit: selectLimit } — preserve that
    //    for the auth call by re-stubbing it explicitly first, then make the
    //    route's `where(...)` (no limit) resolve to our row list.
    selectLimit.mockResolvedValueOnce([{ emailVerifiedAt: new Date() }]);
    selectWhere.mockReturnValueOnce({ limit: selectLimit }).mockResolvedValueOnce([
      {
        id: 'p1',
        slug: 'p-one',
        name: 'P One',
        ownerId: 'uuid-user',
        role: 'owner',
        createdAt: new Date('2026-04-01T00:00:00Z'),
      },
    ]);

    const res = await req('', { token });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ id: string; role: string }>;
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({ id: 'p1', role: 'owner' });
  });
});

describe('GET /api/projects/:id', () => {
  it('400 BAD_REQUEST on non-uuid id', async () => {
    const token = await signUserToken('uuid-user');
    selectLimit.mockResolvedValueOnce([{ emailVerifiedAt: new Date() }]);

    const res = await req('/not-a-uuid', { token });
    expect(res.status).toBe(400);
  });

  it('404 NOT_FOUND when project missing', async () => {
    const token = await signUserToken('uuid-user');
    selectLimit
      .mockResolvedValueOnce([{ emailVerifiedAt: new Date() }]) // verified
      .mockResolvedValueOnce([]); // project lookup -> empty

    const res = await req('/11111111-1111-4111-8111-111111111111', { token });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('NOT_FOUND');
  });

  it('403 FORBIDDEN when not a member', async () => {
    const token = await signUserToken('uuid-stranger');
    selectLimit
      .mockResolvedValueOnce([{ emailVerifiedAt: new Date() }])
      .mockResolvedValueOnce([{ id: 'p1', ownerId: 'uuid-other' }]) // project exists
      .mockResolvedValueOnce([]); // membership lookup -> empty

    const res = await req('/11111111-1111-4111-8111-111111111111', { token });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('FORBIDDEN');
  });

  it('200 with project + members + labels + devicePool for member', async () => {
    const token = await signUserToken('uuid-user');
    selectLimit
      .mockResolvedValueOnce([{ emailVerifiedAt: new Date() }])
      .mockResolvedValueOnce([{ id: 'p1', ownerId: 'uuid-user' }])
      .mockResolvedValueOnce([{ role: 'owner' }])
      .mockResolvedValueOnce([
        {
          id: 'p1',
          slug: 'p-one',
          name: 'P One',
          ownerId: 'uuid-user',
          description: 'desc',
          repoPath: '/repo',
          baseBranch: 'main',
          productionBranch: 'master',
          defaultDeviceId: null,
          agentConfig: null,
          webhookSecret: null,
          createdAt: new Date('2026-04-01T00:00:00Z'),
        },
      ]);
    // First 4 selectWhere calls go through .limit() (auth + 3 lookups);
    // members + labels resolve directly; devicePool flows through innerJoin -> where.
    selectWhere
      .mockReturnValueOnce({ limit: selectLimit })
      .mockReturnValueOnce({ limit: selectLimit })
      .mockReturnValueOnce({ limit: selectLimit })
      .mockReturnValueOnce({ limit: selectLimit })
      .mockResolvedValueOnce([{ userId: 'uuid-user', role: 'owner' }])
      .mockResolvedValueOnce([{ id: 'l1', name: 'bug', color: '#f00' }])
      .mockResolvedValueOnce([
        {
          id: 'd1',
          name: 'Beta-Linux',
          platform: 'linux',
          status: 'online',
          lastSeenAt: null,
          runnerId: 'r1',
        },
      ]);

    const res = await req('/11111111-1111-4111-8111-111111111111', { token });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      id: string;
      description: string;
      repoPath: string;
      members: unknown[];
      labels: unknown[];
      devicePool: Array<{ id: string; runnerId: string }>;
    };
    expect(body.id).toBe('p1');
    expect(body.description).toBe('desc');
    expect(body.repoPath).toBe('/repo');
    expect(body.members).toHaveLength(1);
    expect(body.labels).toHaveLength(1);
    expect(body.devicePool).toHaveLength(1);
    expect(body.devicePool[0]?.runnerId).toBe('r1');
  });

  it('returns the full apiKey to project members (no redaction)', async () => {
    const token = await signUserToken('uuid-user');
    const fullKey = 'fk_aaaabbbbccccddddeeeeffff00001111222233334444555566667777';
    selectLimit
      .mockResolvedValueOnce([{ emailVerifiedAt: new Date() }])
      .mockResolvedValueOnce([{ id: 'p1', ownerId: 'uuid-user' }])
      .mockResolvedValueOnce([{ role: 'owner' }])
      .mockResolvedValueOnce([
        {
          id: 'p1',
          slug: 'p-one',
          name: 'P One',
          ownerId: 'uuid-user',
          description: null,
          repoPath: null,
          baseBranch: null,
          productionBranch: null,
          defaultDeviceId: null,
          agentConfig: null,
          webhookSecret: null,
          apiKey: fullKey,
          createdAt: new Date('2026-04-01T00:00:00Z'),
        },
      ]);
    selectWhere
      .mockReturnValueOnce({ limit: selectLimit })
      .mockReturnValueOnce({ limit: selectLimit })
      .mockReturnValueOnce({ limit: selectLimit })
      .mockReturnValueOnce({ limit: selectLimit })
      .mockResolvedValueOnce([{ userId: 'uuid-user', role: 'owner' }])
      .mockResolvedValueOnce([{ id: 'l1', name: 'bug', color: '#f00' }])
      .mockResolvedValueOnce([
        {
          id: 'd1',
          name: 'Beta-Linux',
          platform: 'linux',
          status: 'online',
          lastSeenAt: null,
          runnerId: 'r1',
        },
      ]);

    const res = await req('/11111111-1111-4111-8111-111111111111', { token });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { apiKey: string };
    expect(body.apiKey).toBe(fullKey);
  });
});

describe('PATCH /api/projects/:id', () => {
  it('400 BAD_REQUEST when no fields supplied', async () => {
    const token = await signUserToken('uuid-user');
    selectLimit.mockResolvedValueOnce([{ emailVerifiedAt: new Date() }]);

    const res = await req('/11111111-1111-4111-8111-111111111111', {
      method: 'PATCH',
      body: JSON.stringify({}),
      token,
    });
    expect(res.status).toBe(400);
  });

  it('403 FORBIDDEN when caller is a non-owner member', async () => {
    const token = await signUserToken('uuid-member');
    selectLimit
      .mockResolvedValueOnce([{ emailVerifiedAt: new Date() }])
      .mockResolvedValueOnce([{ id: 'p1', ownerId: 'uuid-other' }])
      .mockResolvedValueOnce([{ role: 'member' }]);

    const res = await req('/11111111-1111-4111-8111-111111111111', {
      method: 'PATCH',
      body: JSON.stringify({ name: 'New' }),
      token,
    });
    expect(res.status).toBe(403);
  });

  it('200 updates allowed fields when caller is owner', async () => {
    const token = await signUserToken('uuid-owner');
    selectLimit
      .mockResolvedValueOnce([{ emailVerifiedAt: new Date() }])
      .mockResolvedValueOnce([{ id: 'p1', ownerId: 'uuid-owner' }])
      .mockResolvedValueOnce([{ role: 'owner' }]);
    updateReturning.mockResolvedValueOnce([
      {
        id: 'p1',
        slug: 'p-one',
        name: 'New Name',
        ownerId: 'uuid-owner',
        agentConfig: { auto: true },
        webhookSecret: 'secret-of-at-least-16-chars',
        createdAt: new Date(),
      },
    ]);

    const res = await req('/11111111-1111-4111-8111-111111111111', {
      method: 'PATCH',
      body: JSON.stringify({
        name: 'New Name',
        agentConfig: { auto: true },
        webhookSecret: 'secret-of-at-least-16-chars',
      }),
      token,
    });
    expect(res.status).toBe(200);
    expect(updateSet).toHaveBeenCalledWith({
      name: 'New Name',
      agentConfig: { auto: true },
      webhookSecret: 'secret-of-at-least-16-chars',
    });
  });

  it('200 updates new settings fields (description, repoPath, branches, defaultDeviceId)', async () => {
    const token = await signUserToken('uuid-owner');
    selectLimit
      .mockResolvedValueOnce([{ emailVerifiedAt: new Date() }])
      .mockResolvedValueOnce([{ id: 'p1', ownerId: 'uuid-owner' }])
      .mockResolvedValueOnce([{ role: 'owner' }]);
    updateReturning.mockResolvedValueOnce([
      {
        id: 'p1',
        slug: 'p-one',
        name: 'P One',
        ownerId: 'uuid-owner',
        description: 'a project',
        repoPath: '/home/user/repo',
        baseBranch: 'staging',
        productionBranch: 'main',
        defaultDeviceId: '22222222-2222-4222-8222-222222222222',
        agentConfig: null,
        webhookSecret: null,
        createdAt: new Date(),
      },
    ]);

    const res = await req('/11111111-1111-4111-8111-111111111111', {
      method: 'PATCH',
      body: JSON.stringify({
        description: 'a project',
        repoPath: '/home/user/repo',
        baseBranch: 'staging',
        productionBranch: 'main',
        defaultDeviceId: '22222222-2222-4222-8222-222222222222',
      }),
      token,
    });
    expect(res.status).toBe(200);
    expect(updateSet).toHaveBeenCalledWith({
      description: 'a project',
      repoPath: '/home/user/repo',
      baseBranch: 'staging',
      productionBranch: 'main',
      defaultDeviceId: '22222222-2222-4222-8222-222222222222',
    });
  });

  it('200 accepts null defaultDeviceId to clear the assignment', async () => {
    const token = await signUserToken('uuid-owner');
    selectLimit
      .mockResolvedValueOnce([{ emailVerifiedAt: new Date() }])
      .mockResolvedValueOnce([{ id: 'p1', ownerId: 'uuid-owner' }])
      .mockResolvedValueOnce([{ role: 'owner' }]);
    updateReturning.mockResolvedValueOnce([
      {
        id: 'p1',
        slug: 'p-one',
        name: 'P One',
        ownerId: 'uuid-owner',
        description: null,
        repoPath: null,
        baseBranch: null,
        productionBranch: null,
        defaultDeviceId: null,
        agentConfig: null,
        webhookSecret: null,
        createdAt: new Date(),
      },
    ]);

    const res = await req('/11111111-1111-4111-8111-111111111111', {
      method: 'PATCH',
      body: JSON.stringify({ defaultDeviceId: null }),
      token,
    });
    expect(res.status).toBe(200);
    expect(updateSet).toHaveBeenCalledWith({ defaultDeviceId: null });
  });

  it('400 BAD_REQUEST when defaultDeviceId is not a uuid', async () => {
    const token = await signUserToken('uuid-owner');
    selectLimit.mockResolvedValueOnce([{ emailVerifiedAt: new Date() }]);

    const res = await req('/11111111-1111-4111-8111-111111111111', {
      method: 'PATCH',
      body: JSON.stringify({ defaultDeviceId: 'not-a-uuid' }),
      token,
    });
    expect(res.status).toBe(400);
  });

  it('200 updates previewDeploy with testingUrls + testCredentials', async () => {
    const token = await signUserToken('uuid-owner');
    selectLimit
      .mockResolvedValueOnce([{ emailVerifiedAt: new Date() }])
      .mockResolvedValueOnce([{ id: 'p1', ownerId: 'uuid-owner' }])
      .mockResolvedValueOnce([{ role: 'owner' }]);
    updateReturning.mockResolvedValueOnce([
      {
        id: 'p1',
        slug: 'p-one',
        name: 'P One',
        ownerId: 'uuid-owner',
        description: null,
        repoPath: null,
        baseBranch: null,
        productionBranch: null,
        defaultDeviceId: null,
        agentConfig: null,
        previewDeploy: {
          testingUrls: [{ label: 'Staging', url: 'https://staging.example.com' }],
          testCredentials: [{ label: 'Admin', username: 'qa@example.com', password: 'pw123' }],
        },
        webhookSecret: null,
        createdAt: new Date(),
      },
    ]);

    const previewDeploy = {
      testingUrls: [{ label: 'Staging', url: 'https://staging.example.com' }],
      testCredentials: [{ label: 'Admin', username: 'qa@example.com', password: 'pw123' }],
    };

    const res = await req('/11111111-1111-4111-8111-111111111111', {
      method: 'PATCH',
      body: JSON.stringify({ previewDeploy }),
      token,
    });
    expect(res.status).toBe(200);
    expect(updateSet).toHaveBeenCalledWith({ previewDeploy });
  });

  it('200 preserves unknown previewDeploy keys (catchall)', async () => {
    const token = await signUserToken('uuid-owner');
    selectLimit
      .mockResolvedValueOnce([{ emailVerifiedAt: new Date() }])
      .mockResolvedValueOnce([{ id: 'p1', ownerId: 'uuid-owner' }])
      .mockResolvedValueOnce([{ role: 'owner' }]);
    updateReturning.mockResolvedValueOnce([
      {
        id: 'p1',
        slug: 'p-one',
        name: 'P One',
        ownerId: 'uuid-owner',
        description: null,
        repoPath: null,
        baseBranch: null,
        productionBranch: null,
        defaultDeviceId: null,
        agentConfig: null,
        previewDeploy: { stagingUrl: 'https://stg.example.com', testingUrls: [] },
        webhookSecret: null,
        createdAt: new Date(),
      },
    ]);

    const previewDeploy = {
      stagingUrl: 'https://stg.example.com',
      testingUrls: [],
    };

    const res = await req('/11111111-1111-4111-8111-111111111111', {
      method: 'PATCH',
      body: JSON.stringify({ previewDeploy }),
      token,
    });
    expect(res.status).toBe(200);
    expect(updateSet).toHaveBeenCalledWith({ previewDeploy });
  });

  it('200 accepts null previewDeploy to clear config', async () => {
    const token = await signUserToken('uuid-owner');
    selectLimit
      .mockResolvedValueOnce([{ emailVerifiedAt: new Date() }])
      .mockResolvedValueOnce([{ id: 'p1', ownerId: 'uuid-owner' }])
      .mockResolvedValueOnce([{ role: 'owner' }]);
    updateReturning.mockResolvedValueOnce([
      {
        id: 'p1',
        slug: 'p-one',
        name: 'P One',
        ownerId: 'uuid-owner',
        description: null,
        repoPath: null,
        baseBranch: null,
        productionBranch: null,
        defaultDeviceId: null,
        agentConfig: null,
        previewDeploy: null,
        webhookSecret: null,
        createdAt: new Date(),
      },
    ]);

    const res = await req('/11111111-1111-4111-8111-111111111111', {
      method: 'PATCH',
      body: JSON.stringify({ previewDeploy: null }),
      token,
    });
    expect(res.status).toBe(200);
    expect(updateSet).toHaveBeenCalledWith({ previewDeploy: null });
  });

  it('400 BAD_REQUEST when testingUrls[].url is not a valid URL', async () => {
    const token = await signUserToken('uuid-owner');
    selectLimit.mockResolvedValueOnce([{ emailVerifiedAt: new Date() }]);

    const res = await req('/11111111-1111-4111-8111-111111111111', {
      method: 'PATCH',
      body: JSON.stringify({
        previewDeploy: { testingUrls: [{ label: 'X', url: 'not-a-url' }] },
      }),
      token,
    });
    expect(res.status).toBe(400);
  });

  // ISS-188 — token budget schema persistence (W2.3.1).
  it('200 stateContext: writes the patch merged under agentConfig (preserves siblings)', async () => {
    const token = await signUserToken('uuid-owner');
    selectLimit
      .mockResolvedValueOnce([{ emailVerifiedAt: new Date() }])
      .mockResolvedValueOnce([{ id: 'p1', ownerId: 'uuid-owner' }])
      .mockResolvedValueOnce([{ role: 'owner' }])
      .mockResolvedValueOnce([
        {
          agentConfig: {
            pipelineConfig: { enabled: true },
            stateContext: { plan: { blocks: { tip: 'keep' } } },
          },
        },
      ]);
    updateReturning.mockResolvedValueOnce([
      {
        id: 'p1',
        slug: 'p-one',
        name: 'P One',
        ownerId: 'uuid-owner',
        agentConfig: {
          pipelineConfig: { enabled: true },
          stateContext: {
            plan: { blocks: { tip: 'keep' } },
            code: { budget: { perRunUsd: 1, perMonthUsd: 50, action: 'pause' } },
          },
        },
        createdAt: new Date(),
      },
    ]);

    const res = await req('/11111111-1111-4111-8111-111111111111', {
      method: 'PATCH',
      body: JSON.stringify({
        stateContext: {
          code: { budget: { perRunUsd: 1, perMonthUsd: 50, action: 'pause' } },
        },
      }),
      token,
    });
    expect(res.status).toBe(200);
    expect(updateSet).toHaveBeenCalledWith({
      agentConfig: {
        pipelineConfig: { enabled: true },
        stateContext: {
          plan: { blocks: { tip: 'keep' } },
          code: { budget: { perRunUsd: 1, perMonthUsd: 50, action: 'pause' } },
        },
      },
    });
  });

  it('400 BAD_REQUEST when stateContext budget is negative', async () => {
    const token = await signUserToken('uuid-owner');
    selectLimit.mockResolvedValueOnce([{ emailVerifiedAt: new Date() }]);

    const res = await req('/11111111-1111-4111-8111-111111111111', {
      method: 'PATCH',
      body: JSON.stringify({
        stateContext: {
          code: { budget: { perRunUsd: -1, perMonthUsd: 50, action: 'pause' } },
        },
      }),
      token,
    });
    expect(res.status).toBe(400);
  });

  it('400 BAD_REQUEST when stateContext uses an unknown state name', async () => {
    const token = await signUserToken('uuid-owner');
    selectLimit.mockResolvedValueOnce([{ emailVerifiedAt: new Date() }]);

    const res = await req('/11111111-1111-4111-8111-111111111111', {
      method: 'PATCH',
      body: JSON.stringify({
        stateContext: {
          unknown_state: { budget: { perRunUsd: 1, perMonthUsd: 50, action: 'pause' } },
        },
      }),
      token,
    });
    expect(res.status).toBe(400);
  });
});

describe('POST /api/projects/:id/runners (ISS-172)', () => {
  const PID = '11111111-1111-4111-8111-111111111111';
  const DID = '22222222-2222-4222-8222-222222222222';
  const RID = '33333333-3333-4333-8333-333333333333';

  it('403 FORBIDDEN for non-owner non-admin', async () => {
    const token = await signUserToken('uuid-member');
    selectLimit
      .mockResolvedValueOnce([{ emailVerifiedAt: new Date() }])
      .mockResolvedValueOnce([{ id: 'p1', ownerId: 'uuid-other' }])
      .mockResolvedValueOnce([{ role: 'member' }]);

    const res = await req(`/${PID}/runners`, {
      method: 'POST',
      body: JSON.stringify({ deviceId: DID }),
      token,
    });
    expect(res.status).toBe(403);
    expect(insertValues).not.toHaveBeenCalled();
  });

  it('404 DEVICE_NOT_FOUND when deviceId does not exist', async () => {
    const token = await signUserToken('uuid-owner');
    selectLimit
      .mockResolvedValueOnce([{ emailVerifiedAt: new Date() }])
      .mockResolvedValueOnce([{ id: 'p1', ownerId: 'uuid-owner' }])
      .mockResolvedValueOnce([{ role: 'owner' }])
      .mockResolvedValueOnce([]); // device lookup -> empty

    const res = await req(`/${PID}/runners`, {
      method: 'POST',
      body: JSON.stringify({ deviceId: DID }),
      token,
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('DEVICE_NOT_FOUND');
    expect(insertValues).not.toHaveBeenCalled();
  });

  it('201 upserts a claude-code runner row (idempotent, status=online when device fresh)', async () => {
    const token = await signUserToken('uuid-owner');
    const lastSeenAt = new Date();
    selectLimit
      .mockResolvedValueOnce([{ emailVerifiedAt: new Date() }])
      .mockResolvedValueOnce([{ id: 'p1', ownerId: 'uuid-owner' }])
      .mockResolvedValueOnce([{ role: 'owner' }])
      .mockResolvedValueOnce([
        { id: DID, name: 'laptop', status: 'online', lastSeenAt },
      ]);
    insertReturning.mockResolvedValueOnce([
      { id: RID, projectId: PID, deviceId: DID, status: 'online' },
    ]);

    const res = await req(`/${PID}/runners`, {
      method: 'POST',
      body: JSON.stringify({ deviceId: DID }),
      token,
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; status: string };
    expect(body.id).toBe(RID);
    expect(body.status).toBe('online');
    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: PID,
        deviceId: DID,
        type: 'claude-code',
        host: 'device',
        status: 'online',
      }),
    );
    expect(insertOnConflictDoUpdate).toHaveBeenCalled();
  });

  it('201 with status=offline when device.status is offline', async () => {
    const token = await signUserToken('uuid-owner');
    selectLimit
      .mockResolvedValueOnce([{ emailVerifiedAt: new Date() }])
      .mockResolvedValueOnce([{ id: 'p1', ownerId: 'uuid-owner' }])
      .mockResolvedValueOnce([{ role: 'owner' }])
      .mockResolvedValueOnce([
        { id: DID, name: 'laptop', status: 'offline', lastSeenAt: null },
      ]);
    insertReturning.mockResolvedValueOnce([
      { id: RID, projectId: PID, deviceId: DID, status: 'offline' },
    ]);

    const res = await req(`/${PID}/runners`, {
      method: 'POST',
      body: JSON.stringify({ deviceId: DID }),
      token,
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe('offline');
    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'offline' }),
    );
  });

  it('400 BAD_REQUEST when deviceId is not a uuid', async () => {
    const token = await signUserToken('uuid-owner');
    selectLimit.mockResolvedValueOnce([{ emailVerifiedAt: new Date() }]);

    const res = await req(`/${PID}/runners`, {
      method: 'POST',
      body: JSON.stringify({ deviceId: 'not-a-uuid' }),
      token,
    });
    expect(res.status).toBe(400);
  });
});

describe('DELETE /api/projects/:id/runners/:runnerId (ISS-172)', () => {
  const PID = '11111111-1111-4111-8111-111111111111';
  const RID = '33333333-3333-4333-8333-333333333333';

  it('403 FORBIDDEN for non-owner non-admin', async () => {
    const token = await signUserToken('uuid-member');
    selectLimit
      .mockResolvedValueOnce([{ emailVerifiedAt: new Date() }])
      .mockResolvedValueOnce([{ id: 'p1', ownerId: 'uuid-other' }])
      .mockResolvedValueOnce([{ role: 'member' }]);

    const res = await req(`/${PID}/runners/${RID}`, { method: 'DELETE', token });
    expect(res.status).toBe(403);
    expect(deleteWhere).not.toHaveBeenCalled();
  });

  it('204 removes the runner row for owner', async () => {
    const token = await signUserToken('uuid-owner');
    selectLimit
      .mockResolvedValueOnce([{ emailVerifiedAt: new Date() }])
      .mockResolvedValueOnce([{ id: 'p1', ownerId: 'uuid-owner' }])
      .mockResolvedValueOnce([{ role: 'owner' }]);

    const res = await req(`/${PID}/runners/${RID}`, { method: 'DELETE', token });
    expect(res.status).toBe(204);
    expect(deleteWhere).toHaveBeenCalled();
  });
});

describe('POST /api/projects/:id/runners — repoPath/branch (ISS-271)', () => {
  const PID = '11111111-1111-4111-8111-111111111111';
  const DID = '22222222-2222-4222-8222-222222222222';
  const RID = '33333333-3333-4333-8333-333333333333';

  it('passes repoPath/branch into the insert and returns them', async () => {
    const token = await signUserToken('uuid-owner');
    selectLimit
      .mockResolvedValueOnce([{ emailVerifiedAt: new Date() }])
      .mockResolvedValueOnce([{ id: 'p1', ownerId: 'uuid-owner' }])
      .mockResolvedValueOnce([{ role: 'owner' }])
      .mockResolvedValueOnce([
        { id: DID, name: 'laptop', status: 'online', lastSeenAt: new Date() },
      ]);
    insertReturning.mockResolvedValueOnce([
      {
        id: RID,
        projectId: PID,
        deviceId: DID,
        repoPath: '/home/u/code/app',
        branch: 'main',
        status: 'online',
      },
    ]);

    const res = await req(`/${PID}/runners`, {
      method: 'POST',
      body: JSON.stringify({ deviceId: DID, repoPath: '/home/u/code/app', branch: 'main' }),
      token,
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { repoPath: string; branch: string };
    expect(body.repoPath).toBe('/home/u/code/app');
    expect(body.branch).toBe('main');
    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({ repoPath: '/home/u/code/app', branch: 'main' }),
    );
  });
});

describe('PATCH /api/projects/:id/runners/:runnerId (ISS-271)', () => {
  const PID = '11111111-1111-4111-8111-111111111111';
  const RID = '33333333-3333-4333-8333-333333333333';

  it('403 FORBIDDEN for non-owner non-admin', async () => {
    const token = await signUserToken('uuid-member');
    selectLimit
      .mockResolvedValueOnce([{ emailVerifiedAt: new Date() }])
      .mockResolvedValueOnce([{ id: 'p1', ownerId: 'uuid-other' }])
      .mockResolvedValueOnce([{ role: 'member' }]);

    const res = await req(`/${PID}/runners/${RID}`, {
      method: 'PATCH',
      body: JSON.stringify({ repoPath: '/x' }),
      token,
    });
    expect(res.status).toBe(403);
    expect(updateReturning).not.toHaveBeenCalled();
  });

  it('200 updates repoPath/branch for owner', async () => {
    const token = await signUserToken('uuid-owner');
    selectLimit
      .mockResolvedValueOnce([{ emailVerifiedAt: new Date() }])
      .mockResolvedValueOnce([{ id: 'p1', ownerId: 'uuid-owner' }])
      .mockResolvedValueOnce([{ role: 'owner' }]);
    updateReturning.mockResolvedValueOnce([
      {
        id: RID,
        projectId: PID,
        deviceId: '22222222-2222-4222-8222-222222222222',
        repoPath: '/home/u/code/app',
        branch: 'dev',
        status: 'online',
      },
    ]);

    const res = await req(`/${PID}/runners/${RID}`, {
      method: 'PATCH',
      body: JSON.stringify({ repoPath: '/home/u/code/app', branch: 'dev' }),
      token,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { repoPath: string; branch: string };
    expect(body.repoPath).toBe('/home/u/code/app');
    expect(body.branch).toBe('dev');
    expect(updateSet).toHaveBeenCalledWith(
      expect.objectContaining({ repoPath: '/home/u/code/app', branch: 'dev' }),
    );
  });

  it('404 RUNNER_NOT_FOUND when no row matches', async () => {
    const token = await signUserToken('uuid-owner');
    selectLimit
      .mockResolvedValueOnce([{ emailVerifiedAt: new Date() }])
      .mockResolvedValueOnce([{ id: 'p1', ownerId: 'uuid-owner' }])
      .mockResolvedValueOnce([{ role: 'owner' }]);
    updateReturning.mockResolvedValueOnce([]);

    const res = await req(`/${PID}/runners/${RID}`, {
      method: 'PATCH',
      body: JSON.stringify({ repoPath: '/home/u/code/app' }),
      token,
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('RUNNER_NOT_FOUND');
  });

  it('400 BAD_REQUEST on unknown field (strict body)', async () => {
    const token = await signUserToken('uuid-owner');
    selectLimit.mockResolvedValueOnce([{ emailVerifiedAt: new Date() }]);

    const res = await req(`/${PID}/runners/${RID}`, {
      method: 'PATCH',
      body: JSON.stringify({ nope: true }),
      token,
    });
    expect(res.status).toBe(400);
  });
});

describe('POST /api/projects/:id/api-key/rotate', () => {
  const ID = '11111111-1111-4111-8111-111111111111';

  it('403 FORBIDDEN for non-owner non-admin', async () => {
    const token = await signUserToken('uuid-member');
    selectLimit
      .mockResolvedValueOnce([{ emailVerifiedAt: new Date() }])
      .mockResolvedValueOnce([{ id: 'p1', ownerId: 'uuid-other' }])
      .mockResolvedValueOnce([{ role: 'member' }]);

    const res = await req(`/${ID}/api-key/rotate`, { method: 'POST', token });
    expect(res.status).toBe(403);
    expect(updateSet).not.toHaveBeenCalled();
  });

  it('200 with fresh fk_-prefixed key for admin', async () => {
    const token = await signUserToken('uuid-admin');
    selectLimit
      .mockResolvedValueOnce([{ emailVerifiedAt: new Date() }])
      .mockResolvedValueOnce([{ id: 'p1', ownerId: 'uuid-other' }])
      .mockResolvedValueOnce([{ role: 'admin' }]);
    updateReturning.mockImplementationOnce(async () => {
      const setArg = updateSet.mock.calls[0]?.[0] as { apiKey: string };
      return [{ id: 'p1', apiKey: setArg.apiKey }];
    });

    const res = await req(`/${ID}/api-key/rotate`, { method: 'POST', token });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; apiKey: string };
    expect(body.id).toBe('p1');
    expect(body.apiKey).toMatch(/^fk_[0-9a-f]{48}$/);
  });
});

describe('POST /api/projects/:id/skills/bootstrap (ISS-2A)', () => {
  const PID = '11111111-1111-4111-8111-111111111111';
  const EXPECTED_DEFAULT_STAGES = [
    'approved', 'confirmed', 'deploying', 'developed', 'needs_info', 'open',
    'pass', 'released', 'reopen', 'staging', 'tested', 'testing',
  ].sort();
  const SKILL_IDS = {
    triage: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    plan: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    code: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    review: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    test: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    fix: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
    release: '99999999-9999-4999-8999-999999999999',
  };

  function bootstrap(token: string) {
    return req(`/${PID}/skills/bootstrap`, { method: 'POST', token });
  }

  it('403 FORBIDDEN when caller is neither owner nor admin', async () => {
    const token = await signUserToken('uuid-member');
    selectLimit
      .mockResolvedValueOnce([{ emailVerifiedAt: new Date() }])
      .mockResolvedValueOnce([{ id: PID, ownerId: 'uuid-other' }])
      .mockResolvedValueOnce([{ role: 'member' }]);

    const res = await bootstrap(token);
    expect(res.status).toBe(403);
    expect(insertValues).not.toHaveBeenCalled();
  });

  it('201 inserts 7 stage→skill registrations and applies the Balanced preset on first call', async () => {
    const token = await signUserToken('uuid-owner');
    selectLimit
      .mockResolvedValueOnce([{ emailVerifiedAt: new Date() }]) // assertEmailVerified
      .mockResolvedValueOnce([{ id: PID, ownerId: 'uuid-owner' }]) // loadMembership: project
      .mockResolvedValueOnce([{ role: 'owner' }]) // loadMembership: member
      .mockResolvedValueOnce([]) // existing registrations -> none
      .mockResolvedValueOnce([{ agentConfig: null }]); // project agentConfig

    // 5th selectWhere — globalSkills lookup (.where(...) without .limit()).
    // Preceding 5 select calls all use .limit() and consume the
    // selectLimit queue above; the 6th overall select is this one.
    selectWhere
      .mockReturnValueOnce({ limit: selectLimit })
      .mockReturnValueOnce({ limit: selectLimit })
      .mockReturnValueOnce({ limit: selectLimit })
      .mockReturnValueOnce({ limit: selectLimit })
      .mockReturnValueOnce({ limit: selectLimit })
      .mockResolvedValueOnce([
        { id: SKILL_IDS.triage, name: 'forge-triage' },
        { id: SKILL_IDS.plan, name: 'forge-plan' },
        { id: SKILL_IDS.code, name: 'forge-code' },
        { id: SKILL_IDS.review, name: 'forge-review' },
        { id: SKILL_IDS.test, name: 'forge-test' },
        { id: SKILL_IDS.fix, name: 'forge-fix' },
        { id: SKILL_IDS.release, name: 'forge-release' },
      ]);

    // The bootstrap inserts directly into skill_registrations (no .onConflictDoNothing).
    // Override insertValues to be awaitable.
    insertValues.mockReturnValueOnce(Promise.resolve());

    const res = await bootstrap(token);
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      alreadyBootstrapped: boolean;
      skillsBound: number;
      pipelineEnabled: boolean;
    };
    expect(body.alreadyBootstrapped).toBe(false);
    expect(body.skillsBound).toBe(7);
    expect(body.pipelineEnabled).toBe(true);

    expect(insertValues).toHaveBeenCalledTimes(1);
    const inserted = insertValues.mock.calls[0]?.[0] as Array<{ stage: string; skillId: string }>;
    expect(inserted).toHaveLength(7);
    const stages = inserted.map((r) => r.stage).sort();
    expect(stages).toEqual(
      ['approved', 'confirmed', 'developed', 'open', 'released', 'reopen', 'testing'].sort(),
    );

    // The Balanced preset write went through update().set(...).where(...).
    expect(updateSet).toHaveBeenCalledTimes(1);
    const setArg = updateSet.mock.calls[0]?.[0] as { agentConfig: { pipelineConfig: Record<string, unknown> } };
    expect(setArg.agentConfig.pipelineConfig).toMatchObject({
      enabled: true,
      autoTriage: true,
      autoPlan: true,
      autoCode: false,
      autoReview: true,
      autoTest: true,
      autoFix: true,
      autoRelease: false,
    });

    // ISS-108 — bootstrap seeds the per-stage states config alongside the preset.
    const states = (setArg.agentConfig.pipelineConfig as { states: Record<string, unknown> }).states;
    expect(Object.keys(states).sort()).toEqual(EXPECTED_DEFAULT_STAGES);
    for (const key of Object.keys(states)) {
      expect(states[key]).toEqual({ enabled: true, mode: 'auto' });
    }
  });

  it('200 returns alreadyBootstrapped on second call without writing registrations or agentConfig', async () => {
    const token = await signUserToken('uuid-owner');
    selectLimit
      .mockResolvedValueOnce([{ emailVerifiedAt: new Date() }])
      .mockResolvedValueOnce([{ id: PID, ownerId: 'uuid-owner' }])
      .mockResolvedValueOnce([{ role: 'owner' }])
      .mockResolvedValueOnce([{ id: 'reg-1' }]) // existing registrations -> one row, short-circuits
      .mockResolvedValueOnce([
        { agentConfig: { pipelineConfig: { enabled: true, autoTriage: true } } },
      ]);

    // The second call does a count(*) over registrations via .where(...) no limit.
    selectWhere
      .mockReturnValueOnce({ limit: selectLimit })
      .mockReturnValueOnce({ limit: selectLimit })
      .mockReturnValueOnce({ limit: selectLimit })
      .mockReturnValueOnce({ limit: selectLimit })
      .mockReturnValueOnce({ limit: selectLimit })
      .mockResolvedValueOnce([{ count: 7 }] as never);

    const res = await bootstrap(token);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      alreadyBootstrapped: boolean;
      skillsBound: number;
      pipelineEnabled: boolean;
    };
    expect(body).toMatchObject({
      alreadyBootstrapped: true,
      skillsBound: 7,
      pipelineEnabled: true,
    });

    expect(insertValues).not.toHaveBeenCalled();
    // ISS-108 — bootstrap backfills pipelineConfig.states on already-bootstrapped
    // projects that pre-date the field. The existing pipelineConfig here has no
    // `states`, so one update fires to add the default config.
    expect(updateSet).toHaveBeenCalledTimes(1);
    const updateCalls = updateSet.mock.calls as unknown as Array<
      [{ agentConfig: { pipelineConfig: { states: Record<string, unknown> } } }]
    >;
    const patched = updateCalls[0]![0];
    expect(Object.keys(patched.agentConfig.pipelineConfig.states).sort()).toEqual(EXPECTED_DEFAULT_STAGES);
  });

  it('preserves an existing pipelineConfig.enabled flag (does not clobber user choice)', async () => {
    const token = await signUserToken('uuid-owner');
    // First call already set pipelineConfig.enabled=false; bootstrap must
    // skip the preset write and report the user's value back.
    selectLimit
      .mockResolvedValueOnce([{ emailVerifiedAt: new Date() }])
      .mockResolvedValueOnce([{ id: PID, ownerId: 'uuid-owner' }])
      .mockResolvedValueOnce([{ role: 'owner' }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { agentConfig: { pipelineConfig: { enabled: false } } },
      ]);

    selectWhere
      .mockReturnValueOnce({ limit: selectLimit })
      .mockReturnValueOnce({ limit: selectLimit })
      .mockReturnValueOnce({ limit: selectLimit })
      .mockReturnValueOnce({ limit: selectLimit })
      .mockReturnValueOnce({ limit: selectLimit })
      .mockResolvedValueOnce([
        { id: SKILL_IDS.triage, name: 'forge-triage' },
        { id: SKILL_IDS.plan, name: 'forge-plan' },
        { id: SKILL_IDS.code, name: 'forge-code' },
        { id: SKILL_IDS.review, name: 'forge-review' },
        { id: SKILL_IDS.test, name: 'forge-test' },
        { id: SKILL_IDS.fix, name: 'forge-fix' },
        { id: SKILL_IDS.release, name: 'forge-release' },
      ] as never);

    insertValues.mockReturnValueOnce(Promise.resolve() as never);

    const res = await bootstrap(token);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { pipelineEnabled: boolean };
    expect(body.pipelineEnabled).toBe(false);
    // ISS-108 — preset write is skipped (enabled=false is the user's choice),
    // but states still gets backfilled.
    expect(updateSet).toHaveBeenCalledTimes(1);
    const updateCalls = updateSet.mock.calls as unknown as Array<
      [{ agentConfig: { pipelineConfig: { enabled: boolean; states: Record<string, unknown> } } }]
    >;
    const patched = updateCalls[0]![0];
    expect(patched.agentConfig.pipelineConfig.enabled).toBe(false);
    expect(Object.keys(patched.agentConfig.pipelineConfig.states)).toContain('approved');
  });

  it('503 NO_GLOBAL_SKILLS when the seeder has not run', async () => {
    const token = await signUserToken('uuid-owner');
    selectLimit
      .mockResolvedValueOnce([{ emailVerifiedAt: new Date() }])
      .mockResolvedValueOnce([{ id: PID, ownerId: 'uuid-owner' }])
      .mockResolvedValueOnce([{ role: 'owner' }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ agentConfig: null }]);

    selectWhere
      .mockReturnValueOnce({ limit: selectLimit })
      .mockReturnValueOnce({ limit: selectLimit })
      .mockReturnValueOnce({ limit: selectLimit })
      .mockReturnValueOnce({ limit: selectLimit })
      .mockReturnValueOnce({ limit: selectLimit })
      .mockResolvedValueOnce([] as never); // no global skills

    const res = await bootstrap(token);
    expect(res.status).toBe(503);
    expect(insertValues).not.toHaveBeenCalled();
  });
});

describe('GET /api/projects/:id/issues/:issueId/branch-config (ISS-135 PR-A)', () => {
  const PID = '11111111-1111-4111-8111-111111111111';
  const IID = '22222222-2222-4222-8222-222222222222';

  it('400 BAD_REQUEST on non-uuid issueId', async () => {
    const token = await signUserToken('uuid-user');
    selectLimit.mockResolvedValueOnce([{ emailVerifiedAt: new Date() }]);

    const res = await req(`/${PID}/issues/not-a-uuid/branch-config`, { token });
    expect(res.status).toBe(400);
  });

  it('403 FORBIDDEN when caller is not a project member', async () => {
    const token = await signUserToken('uuid-stranger');
    selectLimit
      .mockResolvedValueOnce([{ emailVerifiedAt: new Date() }])
      .mockResolvedValueOnce([{ id: PID, ownerId: 'uuid-other' }])
      .mockResolvedValueOnce([]); // no membership row

    const res = await req(`/${PID}/issues/${IID}/branch-config`, { token });
    expect(res.status).toBe(403);
  });

  it('404 NOT_FOUND when the issue does not exist in the project', async () => {
    const token = await signUserToken('uuid-user');
    selectLimit
      .mockResolvedValueOnce([{ emailVerifiedAt: new Date() }])
      .mockResolvedValueOnce([{ id: PID, ownerId: 'uuid-user' }])
      .mockResolvedValueOnce([{ role: 'owner' }])
      .mockResolvedValueOnce([{ baseBranch: 'develop', productionBranch: 'release' }])
      .mockResolvedValueOnce([]); // issue lookup empty

    const res = await req(`/${PID}/issues/${IID}/branch-config`, { token });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('NOT_FOUND');
  });

  it('200 returns the project defaults when the issue has no override', async () => {
    const token = await signUserToken('uuid-user');
    selectLimit
      .mockResolvedValueOnce([{ emailVerifiedAt: new Date() }])
      .mockResolvedValueOnce([{ id: PID, ownerId: 'uuid-user' }])
      .mockResolvedValueOnce([{ role: 'owner' }])
      .mockResolvedValueOnce([{ baseBranch: 'develop', productionBranch: 'release' }])
      .mockResolvedValueOnce([{ id: IID, sessionContext: null }]);

    const res = await req(`/${PID}/issues/${IID}/branch-config`, { token });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      baseBranch: string;
      targetBranch: string;
      prodBranch: string;
    };
    expect(body).toEqual({
      baseBranch: 'develop',
      targetBranch: 'develop',
      prodBranch: 'release',
    });
  });

  it('200 layers a sessionContext.branchConfig override on top of project defaults', async () => {
    const token = await signUserToken('uuid-user');
    selectLimit
      .mockResolvedValueOnce([{ emailVerifiedAt: new Date() }])
      .mockResolvedValueOnce([{ id: PID, ownerId: 'uuid-user' }])
      .mockResolvedValueOnce([{ role: 'owner' }])
      .mockResolvedValueOnce([{ baseBranch: 'develop', productionBranch: 'release' }])
      .mockResolvedValueOnce([
        {
          id: IID,
          sessionContext: { branchConfig: { baseBranch: 'feat/x', prodBranch: 'hotfix' } },
        },
      ]);

    const res = await req(`/${PID}/issues/${IID}/branch-config`, { token });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      baseBranch: string;
      targetBranch: string;
      prodBranch: string;
    };
    expect(body).toEqual({
      baseBranch: 'feat/x',
      targetBranch: 'feat/x', // follows the overridden base
      prodBranch: 'hotfix',
    });
  });

  it('200 returns null branches (no hard fallback) when project defaults are null and no override — surfaces misconfig', async () => {
    const token = await signUserToken('uuid-user');
    selectLimit
      .mockResolvedValueOnce([{ emailVerifiedAt: new Date() }])
      .mockResolvedValueOnce([{ id: PID, ownerId: 'uuid-user' }])
      .mockResolvedValueOnce([{ role: 'owner' }])
      .mockResolvedValueOnce([{ baseBranch: null, productionBranch: null }])
      .mockResolvedValueOnce([{ id: IID, sessionContext: null }]);

    const res = await req(`/${PID}/issues/${IID}/branch-config`, { token });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      baseBranch: string | null;
      targetBranch: string | null;
      prodBranch: string | null;
    };
    expect(body).toEqual({ baseBranch: null, targetBranch: null, prodBranch: null });
  });
});

describe('DELETE /api/projects/:id', () => {
  it('403 FORBIDDEN when caller is not owner', async () => {
    const token = await signUserToken('uuid-member');
    selectLimit
      .mockResolvedValueOnce([{ emailVerifiedAt: new Date() }])
      .mockResolvedValueOnce([{ id: 'p1', ownerId: 'uuid-other' }])
      .mockResolvedValueOnce([{ role: 'member' }]);

    const res = await req('/11111111-1111-4111-8111-111111111111', {
      method: 'DELETE',
      token,
    });
    expect(res.status).toBe(403);
    expect(deleteWhere).not.toHaveBeenCalled();
  });

  it('204 deletes when caller is owner', async () => {
    const token = await signUserToken('uuid-owner');
    selectLimit
      .mockResolvedValueOnce([{ emailVerifiedAt: new Date() }])
      .mockResolvedValueOnce([{ id: 'p1', ownerId: 'uuid-owner' }])
      .mockResolvedValueOnce([{ role: 'owner' }]);

    const res = await req('/11111111-1111-4111-8111-111111111111', {
      method: 'DELETE',
      token,
    });
    expect(res.status).toBe(204);
    expect(deleteWhere).toHaveBeenCalledTimes(1);
  });
});
