import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_SECRET = 'test-secret-at-least-32-chars-long-abcdef';

vi.mock('../config/env.js', () => ({
  env: { JWT_SECRET: TEST_SECRET, NODE_ENV: 'test' },
}));

const selectLimit = vi.fn();
const selectWhere = vi.fn((): unknown => ({ limit: selectLimit }));
const selectOn = vi.fn(() => ({ where: selectWhere }));
const innerJoin = vi.fn(() => ({ on: selectOn, where: selectWhere }));
const selectFrom = vi.fn(() => ({
  where: selectWhere,
  innerJoin,
}));

// GET / visibility query:
// selectDistinctOn(...).from().innerJoin(orgs).leftJoin().leftJoin().where().orderBy()
const distinctOrderBy = vi.fn((): Promise<unknown[]> => Promise.resolve([]));
const distinctWhere = vi.fn((): Record<string, unknown> => ({ orderBy: distinctOrderBy }));
const distinctLeftJoin = vi.fn(
  (): Record<string, unknown> => ({
    leftJoin: distinctLeftJoin,
    where: distinctWhere,
  }),
);
const distinctInnerJoin = vi.fn(() => ({ leftJoin: distinctLeftJoin }));
const distinctFrom = vi.fn(() => ({ innerJoin: distinctInnerJoin, leftJoin: distinctLeftJoin }));

const txInsertProjectReturning = vi.fn();
const txInsertProjectValues = vi.fn(() => ({ returning: txInsertProjectReturning }));
const txInsertMembersValues = vi.fn(async () => undefined);
const txInsertProject = vi.fn(() => ({ values: txInsertProjectValues }));
const txInsertMembers = vi.fn(() => ({ values: txInsertMembersValues }));

const txInsert = vi.fn();

const dbExecute = vi.fn(async (_statement: unknown): Promise<unknown[]> => []);

const transaction = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
  const tx = {
    insert: txInsert,
    execute: dbExecute,
    delete: dbDelete,
    update: dbUpdate,
    select: vi.fn(() => ({ from: selectFrom })),
  };
  return fn(tx);
});

/**
 * The `agent_config` sub-key patch a `tx.execute` call carried, by the order the calls were made.
 *
 * A drizzle `sql` template interleaves literal `StringChunk`s with the raw bound values, so the
 * values are the chunks that are not `StringChunk`s, in order: the removed-key array, the added-key
 * JSON, then the project id. Read off the statement itself rather than off a shape the route
 * assembled, because the statement is what Postgres runs.
 */
function agentConfigWrites(): Array<{ removed: string[]; added: Record<string, unknown> }> {
  return dbExecute.mock.calls.map(([stmt]) => {
    const chunks = (stmt as unknown as { queryChunks: unknown[] }).queryChunks;
    const bound: string[] = chunks
      .filter(
        (c) => (c as { constructor?: { name?: string } })?.constructor?.name !== 'StringChunk',
      )
      .map((c) => String(c));
    return {
      removed: JSON.parse(bound[0] ?? '[]') as string[],
      added: JSON.parse(bound[1] ?? '{}') as Record<string, unknown>,
    };
  });
}

const updateReturning = vi.fn();
const updateWhere = vi.fn(() => ({ returning: updateReturning }));
const updateSet = vi.fn((..._args: unknown[]) => ({ where: updateWhere }));
const dbUpdate = vi.fn(() => ({ set: updateSet }));

const deleteWhere = vi.fn(async () => undefined);
const dbDelete = vi.fn(() => ({ where: deleteWhere }));

const insertOnConflict = vi.fn(async () => undefined);
const insertReturning = vi.fn();
const insertOnConflictDoUpdate = vi.fn(() => ({ returning: insertReturning }));
const insertValues = vi.fn((..._args: unknown[]) => ({
  onConflictDoNothing: insertOnConflict,
  onConflictDoUpdate: insertOnConflictDoUpdate,
  returning: insertReturning,
}));
const dbInsert = vi.fn(() => ({ values: insertValues }));

vi.mock('../db/client.js', () => ({
  db: {
    select: vi.fn(() => ({ from: selectFrom })),
    selectDistinctOn: vi.fn(() => ({ from: distinctFrom })),
    transaction,
    update: dbUpdate,
    delete: dbDelete,
    insert: dbInsert,
    execute: dbExecute,
  },
}));

const projectAccess = vi.fn();
const personalOrg = vi.fn();
vi.mock('../lib/authz.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/authz.js')>()),
  loadProjectAccess: (...args: unknown[]) => projectAccess(...args),
  loadPersonalOrgId: (...args: unknown[]) => personalOrg(...args),
}));

const { projectRoutes } = await import('./routes.js');
const { environmentsPatchSchema } = await import('./environments.js');
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

const ORG_ID = '99999999-9999-4999-8999-999999999999';

type Role = 'admin' | 'member' | 'viewer' | null;
type OrgRole = 'owner' | 'admin' | 'member' | null;
const access = (role: Role, orgRole: OrgRole = null) => ({
  projectId: 'p1',
  orgId: ORG_ID,
  role,
  orgRole,
});
const notFoundErr = () =>
  new HTTPException(404, { message: 'project not found', cause: { code: 'NOT_FOUND' } });

beforeEach(() => {
  vi.clearAllMocks();
  selectLimit.mockReset();
  selectWhere.mockClear();
  innerJoin.mockClear();
  distinctWhere.mockReset();
  distinctWhere.mockReturnValue({ orderBy: distinctOrderBy });
  distinctOrderBy.mockReset();
  distinctOrderBy.mockResolvedValue([]);
  txInsertProjectReturning.mockReset();
  updateReturning.mockReset();
  deleteWhere.mockClear();
  insertValues.mockClear();
  insertOnConflict.mockClear();
  insertOnConflictDoUpdate.mockClear();
  insertReturning.mockReset();
  projectAccess.mockReset();
  personalOrg.mockReset();
  personalOrg.mockResolvedValue(ORG_ID);
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
  return req('', { method: 'POST', body: JSON.stringify(body), ...(token ? { token } : {}) });
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

  it('201 with created project + admin member row for verified user', async () => {
    const token = await signUserToken('uuid-owner');
    selectLimit.mockResolvedValueOnce([{ emailVerifiedAt: new Date() }]);
    const createdAt = new Date('2026-04-23T00:00:00Z');
    txInsertProjectReturning.mockResolvedValueOnce([
      {
        id: 'proj-1',
        slug: 'my-proj',
        name: 'My Project',
        orgId: ORG_ID,
        createdBy: 'uuid-owner',
        apiKey: 'fk_x',
        createdAt,
      },
    ]);

    const res = await post({ slug: 'my-proj', name: 'My Project' }, token);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; slug: string; createdBy: string };
    expect(body).toMatchObject({
      id: 'proj-1',
      slug: 'my-proj',
      orgId: ORG_ID,
      createdBy: 'uuid-owner',
    });

    expect(txInsertProjectValues).toHaveBeenCalledWith(
      expect.not.objectContaining({ releaseChain: expect.anything() }),
    );
    expect(txInsertProjectValues).toHaveBeenCalledWith(
      expect.objectContaining({
        slug: 'my-proj',
        name: 'My Project',
        orgId: ORG_ID,
        createdBy: 'uuid-owner',
        apiKey: expect.stringMatching(/^fk_[0-9a-f]{48}$/),
        // ISS-274 — `baseBranch` is defaulted at create time so the resolver
        // never surfaces a null-base misconfig for new projects.
        baseBranch: 'main',
        // ISS-1311 — `releaseChain` deliberately is NOT: a new project takes the column's own
        // `[]` default, which says it ships nothing until somebody declares otherwise.
      }),
    );
    expect(txInsertMembersValues).toHaveBeenCalledWith({
      userId: 'uuid-owner',
      projectId: 'proj-1',
      role: 'admin',
    });
  });

  it('500 PERSONAL_ORG_MISSING when the user has no personal org', async () => {
    const token = await signUserToken('uuid-owner');
    selectLimit.mockResolvedValueOnce([{ emailVerifiedAt: new Date() }]);
    personalOrg.mockResolvedValueOnce(null);

    const res = await post({ slug: 'my-proj', name: 'My Project' }, token);
    expect(res.status).toBe(500);
    expect(transaction).not.toHaveBeenCalled();
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

  it.each([
    ['projects_slug_unique', 409],
    ['projects_api_key_unique', 500],
  ])('maps a %s violation to %i', async (constraint_name, status) => {
    const token = await signUserToken('uuid-owner');
    selectLimit.mockResolvedValueOnce([{ emailVerifiedAt: new Date() }]);
    const err = Object.assign(new Error('dup'), { code: '23505', constraint_name });
    txInsertProjectReturning.mockRejectedValueOnce(err);
    expect((await post({ slug: 'taken', name: 'X' }, token)).status).toBe(status);
  });
});

describe('GET /api/projects', () => {
  it('returns the visible projects with effective role', async () => {
    const token = await signUserToken('uuid-user');
    selectLimit.mockResolvedValueOnce([{ emailVerifiedAt: new Date() }]);
    distinctOrderBy.mockResolvedValueOnce([
      {
        id: 'p1',
        slug: 'p-one',
        name: 'P One',
        orgId: ORG_ID,
        createdBy: 'uuid-user',
        memberRole: 'admin',
        orgRole: 'owner',
        apiKey: 'fk_x',
        archivedAt: null,
        createdAt: new Date('2026-04-01T00:00:00Z'),
      },
    ]);

    const res = await req('', { token });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ id: string; role: string; orgRole: string }>;
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({ id: 'p1', role: 'admin', orgRole: 'owner' });
  });

  it('derives project admin from org role when there is no member row', async () => {
    const token = await signUserToken('uuid-user');
    selectLimit.mockResolvedValueOnce([{ emailVerifiedAt: new Date() }]);
    distinctOrderBy.mockResolvedValueOnce([
      {
        id: 'p2',
        slug: 'p-two',
        name: 'P Two',
        orgId: ORG_ID,
        createdBy: 'uuid-other',
        memberRole: null,
        orgRole: 'admin',
        apiKey: 'fk_y',
        archivedAt: null,
        createdAt: new Date('2026-04-01T00:00:00Z'),
      },
    ]);

    const res = await req('', { token });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ id: string; role: string; orgRole: string }>;
    expect(body[0]).toMatchObject({ id: 'p2', role: 'admin', orgRole: 'admin' });
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
    selectLimit.mockResolvedValueOnce([{ emailVerifiedAt: new Date() }]);
    projectAccess.mockRejectedValueOnce(notFoundErr());

    const res = await req('/11111111-1111-4111-8111-111111111111', { token });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('NOT_FOUND');
  });

  it('403 FORBIDDEN when not a member', async () => {
    const token = await signUserToken('uuid-stranger');
    selectLimit.mockResolvedValueOnce([{ emailVerifiedAt: new Date() }]);
    projectAccess.mockResolvedValueOnce(access(null));

    const res = await req('/11111111-1111-4111-8111-111111111111', { token });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('FORBIDDEN');
  });

  it('200 with project + members + labels + devicePool for member', async () => {
    const token = await signUserToken('uuid-user');
    projectAccess.mockResolvedValueOnce(access('admin', 'owner'));
    selectLimit.mockResolvedValueOnce([{ emailVerifiedAt: new Date() }]).mockResolvedValueOnce([
      {
        id: 'p1',
        slug: 'p-one',
        name: 'P One',
        orgId: ORG_ID,
        createdBy: 'uuid-user',
        description: 'desc',
        repoPath: '/repo',
        baseBranch: 'main',
        releaseChain: [{ branch: 'main' }, { branch: 'master', from: 'merge-branch' }],
        defaultDeviceId: null,
        agentConfig: null,
        webhookSecret: null,
        createdAt: new Date('2026-04-01T00:00:00Z'),
      },
    ]);
    // First 2 selectWhere calls go through .limit() (auth + project detail);
    // members + labels resolve directly; devicePool flows through innerJoin -> where.
    selectWhere
      .mockReturnValueOnce({ limit: selectLimit })
      .mockReturnValueOnce({ limit: selectLimit })
      .mockResolvedValueOnce([{ userId: 'uuid-user', role: 'admin' }])
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
      role: string;
      orgRole: string;
      members: unknown[];
      labels: unknown[];
      devicePool: Array<{ id: string; runnerId: string }>;
    };
    expect(body.id).toBe('p1');
    expect(body.description).toBe('desc');
    expect(body.repoPath).toBe('/repo');
    expect(body.role).toBe('admin');
    expect(body.orgRole).toBe('owner');
    expect(body.members).toHaveLength(1);
    expect(body.labels).toHaveLength(1);
    expect(body.devicePool).toHaveLength(1);
    expect(body.devicePool[0]?.runnerId).toBe('r1');
  });

  it('returns the full apiKey to project members (no redaction)', async () => {
    const token = await signUserToken('uuid-user');
    const fullKey = 'fk_aaaabbbbccccddddeeeeffff00001111222233334444555566667777';
    projectAccess.mockResolvedValueOnce(access('member'));
    selectLimit.mockResolvedValueOnce([{ emailVerifiedAt: new Date() }]).mockResolvedValueOnce([
      {
        id: 'p1',
        slug: 'p-one',
        name: 'P One',
        orgId: ORG_ID,
        createdBy: 'uuid-user',
        description: null,
        repoPath: null,
        baseBranch: null,
        releaseChain: [],
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
      .mockResolvedValueOnce([{ userId: 'uuid-user', role: 'member' }])
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

/** The row the PATCH handler returns — every case in this describe differs only
 *  by `agentConfig` and the odd `name`, so the shape lives here once. */
function patchedRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'p1',
    slug: 'p-one',
    name: 'P One',
    orgId: ORG_ID,
    createdBy: 'uuid-owner',
    createdAt: new Date(),
    // ISS-1311 — every read projection carries the chain, and `withRetiredReleaseAxes` derives the
    // three retired names from it, so a row without it is a row core could not have selected.
    releaseChain: [],
    ...over,
  };
}

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

  it('403 FORBIDDEN when caller is a project member without org admin', async () => {
    const token = await signUserToken('uuid-member');
    selectLimit.mockResolvedValueOnce([{ emailVerifiedAt: new Date() }]);
    projectAccess.mockResolvedValueOnce(access('member', 'member'));

    const res = await req('/11111111-1111-4111-8111-111111111111', {
      method: 'PATCH',
      body: JSON.stringify({ name: 'New' }),
      token,
    });
    expect(res.status).toBe(403);
  });

  it('403 FORBIDDEN even for an invited project admin without org role', async () => {
    const token = await signUserToken('uuid-admin');
    selectLimit.mockResolvedValueOnce([{ emailVerifiedAt: new Date() }]);
    projectAccess.mockResolvedValueOnce(access('admin', null));

    const res = await req('/11111111-1111-4111-8111-111111111111', {
      method: 'PATCH',
      body: JSON.stringify({ name: 'New' }),
      token,
    });
    expect(res.status).toBe(403);
  });

  it('200 updates allowed fields when caller is org admin', async () => {
    const token = await signUserToken('uuid-owner');
    selectLimit.mockResolvedValueOnce([{ emailVerifiedAt: new Date() }]);
    projectAccess.mockResolvedValueOnce(access('admin', 'owner'));
    updateReturning.mockResolvedValueOnce([
      patchedRow({
        name: 'New Name',
        webhookSecret: 'secret-of-at-least-16-chars',
      }),
    ]);

    const res = await req('/11111111-1111-4111-8111-111111111111', {
      method: 'PATCH',
      body: JSON.stringify({
        name: 'New Name',
        webhookSecret: 'secret-of-at-least-16-chars',
      }),
      token,
    });
    expect(res.status).toBe(200);
    expect(updateSet).toHaveBeenCalledWith({
      name: 'New Name',
      webhookSecret: 'secret-of-at-least-16-chars',
    });
  });

  it('200 updates new settings fields (description, repoPath, branches, defaultDeviceId)', async () => {
    const token = await signUserToken('uuid-owner');
    selectLimit.mockResolvedValueOnce([{ emailVerifiedAt: new Date() }]);
    projectAccess.mockResolvedValueOnce(access('admin', 'owner'));
    updateReturning.mockResolvedValueOnce([
      patchedRow({
        description: 'a project',
        repoPath: '/home/user/repo',
        baseBranch: 'staging',
        releaseChain: [{ branch: 'staging' }, { branch: 'main', from: 'merge-branch' }],
        defaultDeviceId: '22222222-2222-4222-8222-222222222222',
        agentConfig: null,
        webhookSecret: null,
      }),
    ]);

    // Touching either half makes the PATCH read the row it is about to change, so the chain and
    // the base branch are judged together (ISS-1311).
    selectLimit.mockResolvedValueOnce([{ baseBranch: 'main', releaseChain: [] }]);

    const res = await req('/11111111-1111-4111-8111-111111111111', {
      method: 'PATCH',
      body: JSON.stringify({
        description: 'a project',
        repoPath: '/home/user/repo',
        baseBranch: 'staging',
        releaseChain: [{ branch: 'staging' }, { branch: 'main', from: 'merge-branch' }],
        defaultDeviceId: '22222222-2222-4222-8222-222222222222',
      }),
      token,
    });
    expect(res.status).toBe(200);
    expect(updateSet).toHaveBeenCalledWith({
      description: 'a project',
      repoPath: '/home/user/repo',
      baseBranch: 'staging',
      releaseChain: [{ branch: 'staging' }, { branch: 'main', from: 'merge-branch' }],
      defaultDeviceId: '22222222-2222-4222-8222-222222222222',
    });
  });

  it('200 kind: reaches the UPDATE, so an existing project can be re-shaped as a storefront', async () => {
    const token = await signUserToken('uuid-owner');
    selectLimit.mockResolvedValueOnce([{ emailVerifiedAt: new Date() }]);
    projectAccess.mockResolvedValueOnce(access('admin', 'owner'));
    updateReturning.mockResolvedValueOnce([
      patchedRow({
        kind: 'website',
        agentConfig: null,
        webhookSecret: null,
      }),
    ]);

    const res = await req('/11111111-1111-4111-8111-111111111111', {
      method: 'PATCH',
      body: JSON.stringify({ kind: 'website' }),
      token,
    });
    expect(res.status).toBe(200);
    expect(updateSet).toHaveBeenCalledWith({ kind: 'website' });
  });

  it('400 BAD_REQUEST on an unknown kind, so a typo never turns the git preflight off', async () => {
    const token = await signUserToken('uuid-owner');
    selectLimit.mockResolvedValueOnce([{ emailVerifiedAt: new Date() }]);
    projectAccess.mockResolvedValueOnce(access('admin', 'owner'));

    const res = await req('/11111111-1111-4111-8111-111111111111', {
      method: 'PATCH',
      body: JSON.stringify({ kind: 'storefront' }),
      token,
    });
    expect(res.status).toBe(400);
    expect(updateSet).not.toHaveBeenCalled();
  });

  it('200 accepts null defaultDeviceId to clear the assignment', async () => {
    const token = await signUserToken('uuid-owner');
    selectLimit.mockResolvedValueOnce([{ emailVerifiedAt: new Date() }]);
    projectAccess.mockResolvedValueOnce(access('admin', 'owner'));
    updateReturning.mockResolvedValueOnce([
      patchedRow({
        description: null,
        repoPath: null,
        baseBranch: null,
        releaseChain: [],
        defaultDeviceId: null,
        agentConfig: null,
        webhookSecret: null,
      }),
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
});

/**
 * ISS-1069 — `environments` on PATCH, as its own block.
 *
 * Its own `describe` and not a longer one above, because the block above was at the function line
 * budget: every case here is about one field of one column, and the cases above are about the rest
 * of the route.
 */
describe('PATCH /api/projects/:id · environments has its own door now', () => {
  it('400 refuses `environments` by name rather than writing the column', async () => {
    const token = await signUserToken('uuid-owner');
    selectLimit.mockResolvedValueOnce([{ emailVerifiedAt: new Date() }]);

    const res = await req('/11111111-1111-4111-8111-111111111111', {
      method: 'PATCH',
      body: JSON.stringify({ environments: { limits: 'no email' } }),
      token,
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code?: string; message?: string };
    expect(body.code).toBe('ENVIRONMENTS_MOVED');
    expect(updateSet).not.toHaveBeenCalled();
  });

  it('names the route that owns the document now, and the shape it takes', async () => {
    const token = await signUserToken('uuid-owner');
    selectLimit.mockResolvedValueOnce([{ emailVerifiedAt: new Date() }]);

    const res = await req('/11111111-1111-4111-8111-111111111111', {
      method: 'PATCH',
      body: JSON.stringify({ environments: null }),
      token,
    });
    const body = (await res.json()) as { message?: string };
    expect(body.message).toContain('PATCH /api/projects/:id/environments');
    expect(body.message).toContain('{ base, patch }');
  });

  it('200 leaves the column alone for a patch that omits environments', async () => {
    const token = await signUserToken('uuid-owner');
    selectLimit.mockResolvedValueOnce([{ emailVerifiedAt: new Date() }]);
    projectAccess.mockResolvedValueOnce(access('admin', 'owner'));
    updateReturning.mockResolvedValueOnce([patchedRow({ name: 'Renamed' })]);

    const res = await req('/11111111-1111-4111-8111-111111111111', {
      method: 'PATCH',
      body: JSON.stringify({ name: 'Renamed' }),
      token,
    });
    expect(res.status).toBe(200);
    expect(updateSet).toHaveBeenCalledWith({ name: 'Renamed' });
    expect(updateSet.mock.calls[0]?.[0]).not.toHaveProperty('environments');
  });
});

describe('PATCH /api/projects/:id · retired keys and the agentConfig doors', () => {
  const RETIRED_BODIES: [string, Record<string, unknown>, string][] = [
    [
      'the scoped stateContext field',
      { stateContext: { code: { modelOverride: 'opus' } } },
      'agentConfig.stateContext decides nothing',
    ],
    [
      'a null scoped stateContext',
      { stateContext: null },
      'agentConfig.stateContext decides nothing',
    ],
    [
      'stateContext inside a wholesale agentConfig',
      { agentConfig: { stateContext: { code: {} } } },
      'agentConfig.stateContext decides nothing',
    ],
    [
      'the retired pipeline config inside a wholesale agentConfig',
      { agentConfig: { pipelineConfig: { states: { open: { skillName: 'forge-review' } } } } },
      'is not a key this project',
    ],
    // ISS-1069 — the retired column name. The object below would strip it silently, which answers
    // an operator's save with a 200 and no write.
    [
      'the retired previewDeploy key',
      { previewDeploy: { stagingUrl: 'https://stg.example.com' } },
      'previewDeploy has been renamed to environments',
    ],
    [
      'a null previewDeploy',
      { previewDeploy: null },
      'previewDeploy has been renamed to environments',
    ],
    // ISS-1070 — the shadow copies of real columns and the dead selector key. Each names the thing
    // that owns its value, because "remove this key" alone leaves the operator with a setting they
    // believed in and nowhere to put it. The fourth shadow is named after a column ISS-1046 retired,
    // so its case lives in `tests/integration/agent-config-doors-e2e.test.ts` instead — one of the
    // four files `check-retired-model.mjs` exempts, which this file deliberately is not.
    [
      'the shadow repoPath',
      { agentConfig: { repoPath: '/home/kieutrung/tools/forge/jarvis-agents' } },
      'the `projects.repo_path` column',
    ],
    [
      'the shadow baseBranch',
      { agentConfig: { baseBranch: 'main' } },
      'the `projects.base_branch` column',
    ],
    [
      'the shadow activeDeviceId',
      { agentConfig: { activeDeviceId: '85644100-e4f5-455a-9754-6af76c19e50a' } },
      'the `projects.default_device_id` column',
    ],
    [
      'the dead runnerFallback',
      { agentConfig: { runnerFallback: { type: 'claude-code' } } },
      'agentConfig.runnerFallback decides nothing',
    ],
    [
      'a null agentConfig, which used to clear the whole column',
      { agentConfig: null },
      'Clear each value through its own door',
    ],
  ];

  for (const [label, body, names] of RETIRED_BODIES) {
    it(`400 BAD_REQUEST naming the retired key for ${label}, and writes nothing`, async () => {
      const token = await signUserToken('uuid-owner');
      selectLimit.mockResolvedValueOnce([{ emailVerifiedAt: new Date() }]);

      const res = await req('/11111111-1111-4111-8111-111111111111', {
        method: 'PATCH',
        body: JSON.stringify(body),
        token,
      });
      expect(res.status).toBe(400);
      expect(await res.text()).toContain(names);
      expect(updateSet).not.toHaveBeenCalled();
    });
  }

  it('names the policy, which does decide, when it refuses stateContext', async () => {
    const token = await signUserToken('uuid-owner');
    selectLimit.mockResolvedValueOnce([{ emailVerifiedAt: new Date() }]);

    const res = await req('/11111111-1111-4111-8111-111111111111', {
      method: 'PATCH',
      body: JSON.stringify({ stateContext: { code: { modelOverride: 'opus' } } }),
      token,
    });
    const text = await res.text();
    expect(text).toContain("its state's `model` in the project's policy");
    expect(text).toContain('PUT /api/projects/:id/policy');
  });

  it.each([
    ['a declared key', { plugins: [] }, '`PATCH /api/projects/:id/plugins`'],
    ['a declared key with a scoped field', { personaStyle: 'terse' }, '`personaStyle` field'],
    ['a key nothing declares', { whatIsThis: 1 }, 'is not a key this project'],
  ])(
    '400: a wholesale agentConfig carrying %s is refused naming its door, and writes nothing',
    async (_label, agentConfig, names) => {
      const token = await signUserToken('uuid-owner');
      projectAccess.mockResolvedValueOnce(access('admin', 'owner'));
      selectLimit.mockResolvedValueOnce([{ emailVerifiedAt: new Date() }]);

      const res = await req('/11111111-1111-4111-8111-111111111111', {
        method: 'PATCH',
        body: JSON.stringify({ agentConfig }),
        token,
      });
      expect(res.status).toBe(400);
      expect(await res.text()).toContain(names);
      expect(updateSet).not.toHaveBeenCalled();
      expect(dbExecute).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['rocketChatAnswerMode', 'agent', { rocketChatAnswerMode: 'agent' }, []],
    ['rocketChatAnswerMode', null, {}, ['rocketChatAnswerMode']],
    ['personaStyle', 'be terse', { personaStyle: 'be terse' }, []],
    ['personaStyle', '', {}, ['personaStyle']],
    ['personaStyle', null, {}, ['personaStyle']],
    ['systemPrompt', 'answer in Vietnamese', { systemPrompt: 'answer in Vietnamese' }, []],
    ['systemPrompt', null, {}, ['systemPrompt']],
    ['categories', ['bug'], { categories: ['bug'] }, []],
    ['categories', [], { categories: [] }, []],
    ['categories', null, {}, ['categories']],
  ] as Array<[string, unknown, Record<string, unknown>, string[]]>)(
    '200 %s=%j writes that key alone, adding %j and removing %j',
    async (field, value, added, removed) => {
      const token = await signUserToken('uuid-owner');
      projectAccess.mockResolvedValueOnce(access('admin', 'owner'));
      selectLimit
        .mockResolvedValueOnce([{ emailVerifiedAt: new Date() }])
        .mockResolvedValueOnce([patchedRow({})]);

      const res = await req('/11111111-1111-4111-8111-111111111111', {
        method: 'PATCH',
        body: JSON.stringify({ [field]: value }),
        token,
      });
      expect(res.status).toBe(200);
      expect(agentConfigWrites()).toEqual([{ added, removed }]);
      // The `projects` columns are not touched by a config-only patch — there is nothing to set.
      expect(updateSet).not.toHaveBeenCalled();
    },
  );

  it('names no key it was not asked to write', async () => {
    const token = await signUserToken('uuid-owner');
    projectAccess.mockResolvedValueOnce(access('admin', 'owner'));
    selectLimit
      .mockResolvedValueOnce([{ emailVerifiedAt: new Date() }])
      .mockResolvedValueOnce([patchedRow({})]);

    const res = await req('/11111111-1111-4111-8111-111111111111', {
      method: 'PATCH',
      body: JSON.stringify({ personaStyle: 'terse', categories: null }),
      token,
    });
    expect(res.status).toBe(200);
    expect(agentConfigWrites()).toEqual([
      { added: { personaStyle: 'terse' }, removed: ['categories'] },
    ]);
  });

  it('writes the scoped key through the transaction handle and not the bare db', async () => {
    const token = await signUserToken('uuid-owner');
    projectAccess.mockResolvedValueOnce(access('admin', 'owner'));
    selectLimit
      .mockResolvedValueOnce([{ emailVerifiedAt: new Date() }])
      .mockResolvedValueOnce([patchedRow({})]);

    await req('/11111111-1111-4111-8111-111111111111', {
      method: 'PATCH',
      body: JSON.stringify({ systemPrompt: 'hello' }),
      token,
    });
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(dbExecute).toHaveBeenCalledTimes(1);
  });

  it("400 BAD_REQUEST when rocketChatAnswerMode is not 'fast'|'agent'", async () => {
    const token = await signUserToken('uuid-owner');
    selectLimit.mockResolvedValueOnce([{ emailVerifiedAt: new Date() }]);

    const res = await req('/11111111-1111-4111-8111-111111111111', {
      method: 'PATCH',
      body: JSON.stringify({ rocketChatAnswerMode: 'slow' }),
      token,
    });
    expect(res.status).toBe(400);
  });
});

describe('POST /api/projects/:id/api-key/rotate', () => {
  const ID = '11111111-1111-4111-8111-111111111111';

  it('403 FORBIDDEN for non-admin member', async () => {
    const token = await signUserToken('uuid-member');
    selectLimit.mockResolvedValueOnce([{ emailVerifiedAt: new Date() }]);
    projectAccess.mockResolvedValueOnce(access('member'));

    const res = await req(`/${ID}/api-key/rotate`, { method: 'POST', token });
    expect(res.status).toBe(403);
    expect(updateSet).not.toHaveBeenCalled();
  });

  it('200 with fresh fk_-prefixed key for admin', async () => {
    const token = await signUserToken('uuid-admin');
    selectLimit.mockResolvedValueOnce([{ emailVerifiedAt: new Date() }]);
    projectAccess.mockResolvedValueOnce(access('admin'));
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
    selectLimit.mockResolvedValueOnce([{ emailVerifiedAt: new Date() }]);
    projectAccess.mockResolvedValueOnce(access(null));

    const res = await req(`/${PID}/issues/${IID}/branch-config`, { token });
    expect(res.status).toBe(403);
  });

  it('404 NOT_FOUND when the issue does not exist in the project', async () => {
    const token = await signUserToken('uuid-user');
    projectAccess.mockResolvedValueOnce(access('member'));
    selectLimit
      .mockResolvedValueOnce([{ emailVerifiedAt: new Date() }])
      .mockResolvedValueOnce([
        {
          baseBranch: 'develop',
          releaseChain: [{ branch: 'develop' }, { branch: 'release', from: 'merge-branch' }],
        },
      ])
      .mockResolvedValueOnce([]);

    const res = await req(`/${PID}/issues/${IID}/branch-config`, { token });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('NOT_FOUND');
  });

  it('200 returns the project defaults when the issue has no override', async () => {
    const token = await signUserToken('uuid-user');
    projectAccess.mockResolvedValueOnce(access('member'));
    selectLimit
      .mockResolvedValueOnce([{ emailVerifiedAt: new Date() }])
      .mockResolvedValueOnce([
        {
          baseBranch: 'develop',
          releaseChain: [{ branch: 'develop' }, { branch: 'release', from: 'merge-branch' }],
        },
      ])
      .mockResolvedValueOnce([{ id: IID, sessionContext: null }]);

    const res = await req(`/${PID}/issues/${IID}/branch-config`, { token });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      baseBranch: string;
      targetBranch: string;
      liveBranch: string;
    };
    expect(body).toEqual({
      baseBranch: 'develop',
      targetBranch: 'develop',
      liveBranch: 'release',
    });
  });

  it('200 layers a sessionContext.branchConfig override on top of project defaults', async () => {
    const token = await signUserToken('uuid-user');
    projectAccess.mockResolvedValueOnce(access('member'));
    selectLimit
      .mockResolvedValueOnce([{ emailVerifiedAt: new Date() }])
      .mockResolvedValueOnce([
        {
          baseBranch: 'develop',
          releaseChain: [{ branch: 'develop' }, { branch: 'release', from: 'merge-branch' }],
        },
      ])
      .mockResolvedValueOnce([
        {
          id: IID,
          sessionContext: { branchConfig: { baseBranch: 'feat/x', liveBranch: 'hotfix' } },
        },
      ]);

    const res = await req(`/${PID}/issues/${IID}/branch-config`, { token });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      baseBranch: string;
      targetBranch: string;
      liveBranch: string;
    };
    expect(body).toEqual({
      baseBranch: 'feat/x',
      targetBranch: 'feat/x', // follows the overridden base
      liveBranch: 'hotfix',
    });
  });

  it('200 returns null branches (no hard fallback) when project defaults are null and no override — surfaces misconfig', async () => {
    const token = await signUserToken('uuid-user');
    projectAccess.mockResolvedValueOnce(access('member'));
    selectLimit
      .mockResolvedValueOnce([{ emailVerifiedAt: new Date() }])
      .mockResolvedValueOnce([{ baseBranch: null, releaseChain: [] }])
      .mockResolvedValueOnce([{ id: IID, sessionContext: null }]);

    const res = await req(`/${PID}/issues/${IID}/branch-config`, { token });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      baseBranch: string | null;
      targetBranch: string | null;
      liveBranch: string | null;
    };
    expect(body).toEqual({ baseBranch: null, targetBranch: null, liveBranch: null });
  });
});

describe('POST /api/projects/:id/archive (ISS-353)', () => {
  it('403 FORBIDDEN when caller is not org admin', async () => {
    const token = await signUserToken('uuid-member');
    selectLimit.mockResolvedValueOnce([{ emailVerifiedAt: new Date() }]);
    projectAccess.mockResolvedValueOnce(access('member', 'member'));

    const res = await req('/11111111-1111-4111-8111-111111111111/archive', {
      method: 'POST',
      token,
    });
    expect(res.status).toBe(403);
    expect(updateSet).not.toHaveBeenCalled();
  });

  it('200 archives when caller is org owner (sets archivedAt)', async () => {
    const token = await signUserToken('uuid-owner');
    selectLimit.mockResolvedValueOnce([{ emailVerifiedAt: new Date() }]);
    projectAccess.mockResolvedValueOnce(access('admin', 'owner'));
    updateReturning.mockResolvedValueOnce([
      {
        id: 'p1',
        slug: 'p-one',
        name: 'P One',
        orgId: ORG_ID,
        createdBy: 'uuid-owner',
        apiKey: 'fk_x',
        archivedAt: new Date('2026-06-02T00:00:00Z'),
        createdAt: new Date(),
      },
    ]);

    const res = await req('/11111111-1111-4111-8111-111111111111/archive', {
      method: 'POST',
      token,
    });
    expect(res.status).toBe(200);
    expect(updateSet).toHaveBeenCalledTimes(1);
    const body = (await res.json()) as { archivedAt: string | null };
    expect(body.archivedAt).not.toBeNull();
  });
});

describe('POST /api/projects/:id/unarchive (ISS-353)', () => {
  it('403 FORBIDDEN when caller is not org admin', async () => {
    const token = await signUserToken('uuid-member');
    selectLimit.mockResolvedValueOnce([{ emailVerifiedAt: new Date() }]);
    projectAccess.mockResolvedValueOnce(access('member', 'member'));

    const res = await req('/11111111-1111-4111-8111-111111111111/unarchive', {
      method: 'POST',
      token,
    });
    expect(res.status).toBe(403);
    expect(updateSet).not.toHaveBeenCalled();
  });

  it('200 unarchives when caller is org owner (clears archivedAt)', async () => {
    const token = await signUserToken('uuid-owner');
    selectLimit.mockResolvedValueOnce([{ emailVerifiedAt: new Date() }]);
    projectAccess.mockResolvedValueOnce(access('admin', 'owner'));
    updateReturning.mockResolvedValueOnce([
      {
        id: 'p1',
        slug: 'p-one',
        name: 'P One',
        orgId: ORG_ID,
        createdBy: 'uuid-owner',
        apiKey: 'fk_x',
        archivedAt: null,
        createdAt: new Date(),
      },
    ]);

    const res = await req('/11111111-1111-4111-8111-111111111111/unarchive', {
      method: 'POST',
      token,
    });
    expect(res.status).toBe(200);
    expect(updateSet).toHaveBeenCalledWith({ archivedAt: null });
    const body = (await res.json()) as { archivedAt: string | null };
    expect(body.archivedAt).toBeNull();
  });
});

describe('DELETE /api/projects/:id', () => {
  it('403 FORBIDDEN when caller is not org admin', async () => {
    const token = await signUserToken('uuid-member');
    selectLimit.mockResolvedValueOnce([{ emailVerifiedAt: new Date() }]);
    projectAccess.mockResolvedValueOnce(access('member', 'member'));

    const res = await req('/11111111-1111-4111-8111-111111111111', {
      method: 'DELETE',
      token,
    });
    expect(res.status).toBe(403);
    expect(deleteWhere).not.toHaveBeenCalled();
  });

  it('403 FORBIDDEN for an invited project admin without org role', async () => {
    const token = await signUserToken('uuid-admin');
    selectLimit.mockResolvedValueOnce([{ emailVerifiedAt: new Date() }]);
    projectAccess.mockResolvedValueOnce(access('admin', null));

    const res = await req('/11111111-1111-4111-8111-111111111111', {
      method: 'DELETE',
      token,
    });
    expect(res.status).toBe(403);
    expect(deleteWhere).not.toHaveBeenCalled();
  });

  it('204 deletes when caller is org admin', async () => {
    const token = await signUserToken('uuid-owner');
    selectLimit.mockResolvedValueOnce([{ emailVerifiedAt: new Date() }]);
    projectAccess.mockResolvedValueOnce(access('admin', 'admin'));

    const res = await req('/11111111-1111-4111-8111-111111111111', {
      method: 'DELETE',
      token,
    });
    expect(res.status).toBe(204);
    expect(deleteWhere).toHaveBeenCalledTimes(1);
  });
});

describe('environmentsPatchSchema · limits (ISS-767, ISS-1069)', () => {
  it('accepts the limits text alongside the resources it qualifies', () => {
    const r = environmentsPatchSchema.parse({
      preview: { urls: [{ url: 'https://beta.example.com', label: 'Beta' }] },
      limits:
        'The QA account is not a member of every project — check before promising a live walk.',
    });
    expect(r.limits).toContain('not a member');
  });

  it('accepts null to clear it, and trims', () => {
    expect(environmentsPatchSchema.parse({ limits: null }).limits).toBeNull();
    expect(environmentsPatchSchema.parse({ limits: '  x  ' }).limits).toBe('x');
  });

  it('leaves the other fields untouched when only limits is sent', () => {
    const r = environmentsPatchSchema.parse({ limits: 'x' });
    expect(r.preview).toBeUndefined();
    expect(r.live).toBeUndefined();
    expect(r.testCredentials).toBeUndefined();
  });
});

/**
 * ISS-1311 / ADR 0003 — the release shape is `projects.release_chain`, and the three names that
 * spelled it are answered on the way OUT and refused on the way IN.
 *
 * This is the expand half of a priced expand/contract amnesty: `forge-plugin` reads `releaseModel`,
 * `liveBranch` and `releaseStrategy`, the two repositories ship on different clocks, and the `forge`
 * CLI answers with core — so a read keeps answering them, derived one way from the chain. A WRITE
 * does not, because a second way to say what the chain says is a fallback rather than a projection.
 *
 * These cases replace the ISS-1046 block that read a stale `live_branch` through the enum. That
 * staleness cannot exist here: the column is gone, so there is no second value to withhold.
 */
describe('the REST doors answer the retired axes from the chain, and refuse them on a write', () => {
  const PID = '11111111-1111-4111-8111-111111111111';
  const IID = '22222222-2222-4222-8222-222222222222';

  async function detail(row: Record<string, unknown>) {
    const token = await signUserToken('uuid-user');
    projectAccess.mockResolvedValueOnce(access('admin', 'owner'));
    selectLimit.mockResolvedValueOnce([{ emailVerifiedAt: new Date() }]).mockResolvedValueOnce([
      {
        id: 'p1',
        slug: 'p-one',
        name: 'P One',
        orgId: ORG_ID,
        createdBy: 'uuid-user',
        baseBranch: 'main',
        ...row,
      },
    ]);
    selectWhere
      .mockReturnValueOnce({ limit: selectLimit })
      .mockReturnValueOnce({ limit: selectLimit })
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    const res = await req(`/${PID}`, { token });
    expect(res.status).toBe(200);
    return (await res.json()) as {
      releaseChain: { branch: string; from?: string }[];
      liveBranch: string | null;
      releaseModel: string | null;
      releaseStrategy: string | null;
    };
  }

  it('GET answers the chain, and the three retired names derived from it', async () => {
    const body = await detail({
      releaseChain: [{ branch: 'main' }, { branch: 'production', from: 'merge-branch' }],
    });
    expect(body.releaseChain).toEqual([
      { branch: 'main' },
      { branch: 'production', from: 'merge-branch' },
    ]);
    expect(body.liveBranch).toBe('production');
    expect(body.releaseModel).toBe('promote');
    expect(body.releaseStrategy).toBe('merge-branch');
  });

  it('GET answers `publish` and no live branch for a chain that crosses nothing', async () => {
    const body = await detail({ releaseChain: [{ branch: 'main' }] });
    expect(body.liveBranch).toBeNull();
    expect(body.releaseModel).toBe('publish');
    expect(body.releaseStrategy).toBeNull();
  });

  it('GET answers `none` for an empty chain, which is a declaration and not a gap', async () => {
    const body = await detail({ releaseChain: [] });
    expect(body.liveBranch).toBeNull();
    expect(body.releaseModel).toBe('none');
  });

  it('GET derives the LAST crossing of a chain longer than two, not the first', async () => {
    const body = await detail({
      releaseChain: [
        { branch: 'main' },
        { branch: 'stg', from: 'merge-branch' },
        { branch: 'live', from: 'cherry-pick' },
      ],
    });
    expect(body.liveBranch).toBe('live');
    expect(body.releaseStrategy).toBe('cherry-pick');
  });

  it.each([
    ['releaseModel', { releaseModel: 'none' }],
    ['liveBranch', { liveBranch: 'production' }],
    ['releaseStrategy', { releaseStrategy: 'merge-branch' }],
  ])('PATCH refuses %s by name, and names releaseChain as what to send', async (key, patch) => {
    const token = await signUserToken('uuid-owner');
    selectLimit.mockResolvedValueOnce([{ emailVerifiedAt: new Date() }]);

    const res = await req(`/${PID}`, { method: 'PATCH', body: JSON.stringify(patch), token });

    expect(res.status).toBe(400);
    const text = await res.text();
    expect(text).toContain(`\`${key}\` was retired by ISS-1311`);
    expect(text).toContain('releaseChain');
    expect(updateSet).not.toHaveBeenCalled();
  });

  it('PATCH refuses a chain whose first entry declares a crossing', async () => {
    const token = await signUserToken('uuid-owner');
    selectLimit.mockResolvedValueOnce([{ emailVerifiedAt: new Date() }]);

    const res = await req(`/${PID}`, {
      method: 'PATCH',
      body: JSON.stringify({ releaseChain: [{ branch: 'main', from: 'merge-branch' }] }),
      token,
    });

    expect(res.status).toBe(400);
    expect(await res.text()).toContain('RELEASE_CHAIN_FIRST_CROSSES_NOTHING');
    expect(updateSet).not.toHaveBeenCalled();
  });

  // ISS-1311 — `releaseModelGap` silently wrote `merge-branch` into a promote project that named
  // no strategy. That default is the unreported normalisation ADR 0003 removes, so the same input
  // is now refused rather than filled in.
  it('PATCH refuses an entry after the first that declares no crossing, rather than defaulting it', async () => {
    const token = await signUserToken('uuid-owner');
    selectLimit.mockResolvedValueOnce([{ emailVerifiedAt: new Date() }]);

    const res = await req(`/${PID}`, {
      method: 'PATCH',
      body: JSON.stringify({ releaseChain: [{ branch: 'main' }, { branch: 'production' }] }),
      token,
    });

    expect(res.status).toBe(400);
    expect(await res.text()).toContain('RELEASE_CHAIN_EDGE_UNDECLARED');
    expect(updateSet).not.toHaveBeenCalled();
  });

  it('PATCH refuses a chain that names the same branch twice', async () => {
    const token = await signUserToken('uuid-owner');
    selectLimit.mockResolvedValueOnce([{ emailVerifiedAt: new Date() }]);

    const res = await req(`/${PID}`, {
      method: 'PATCH',
      body: JSON.stringify({
        releaseChain: [{ branch: 'main' }, { branch: 'main', from: 'merge-branch' }],
      }),
      token,
    });

    expect(res.status).toBe(400);
    expect(await res.text()).toContain('RELEASE_CHAIN_BRANCH_REPEATED');
    expect(updateSet).not.toHaveBeenCalled();
  });

  it('PATCH refuses a chain and a base branch that name different first branches', async () => {
    const token = await signUserToken('uuid-owner');
    selectLimit.mockResolvedValueOnce([{ emailVerifiedAt: new Date() }]);
    projectAccess.mockResolvedValueOnce(access('admin', 'owner'));
    selectLimit.mockResolvedValueOnce([{ baseBranch: 'main', releaseChain: [] }]);

    const res = await req(`/${PID}`, {
      method: 'PATCH',
      body: JSON.stringify({ baseBranch: 'dev', releaseChain: [{ branch: 'main' }] }),
      token,
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { message?: string };
    expect(body.message).toContain('RELEASE_CHAIN_BASE_MISMATCH');
    expect(body.message).toContain('`main`');
    expect(body.message).toContain('`dev`');
  });

  it('PATCH refuses a base branch sent alone that would part it from a stored chain', async () => {
    const token = await signUserToken('uuid-owner');
    selectLimit.mockResolvedValueOnce([{ emailVerifiedAt: new Date() }]);
    projectAccess.mockResolvedValueOnce(access('admin', 'owner'));
    selectLimit.mockResolvedValueOnce([
      {
        baseBranch: 'main',
        releaseChain: [{ branch: 'main' }, { branch: 'live', from: 'merge-branch' }],
      },
    ]);

    const res = await req(`/${PID}`, {
      method: 'PATCH',
      body: JSON.stringify({ baseBranch: 'dev' }),
      token,
    });

    expect(res.status).toBe(400);
    expect(await res.text()).toContain('RELEASE_CHAIN_BASE_MISMATCH');
  });

  it('PATCH accepts a base branch and a chain that agree, and writes both', async () => {
    const token = await signUserToken('uuid-owner');
    selectLimit.mockResolvedValueOnce([{ emailVerifiedAt: new Date() }]);
    projectAccess.mockResolvedValueOnce(access('admin', 'owner'));
    updateReturning.mockResolvedValueOnce([
      patchedRow({ baseBranch: 'dev', releaseChain: [{ branch: 'dev' }] }),
    ]);
    selectLimit.mockResolvedValueOnce([{ baseBranch: 'main', releaseChain: [] }]);

    const res = await req(`/${PID}`, {
      method: 'PATCH',
      body: JSON.stringify({ baseBranch: 'dev', releaseChain: [{ branch: 'dev' }] }),
      token,
    });

    expect(res.status).toBe(200);
    expect(updateSet).toHaveBeenCalledWith({
      baseBranch: 'dev',
      releaseChain: [{ branch: 'dev' }],
    });
  });

  it('PATCH accepts a base branch alone where the project ships nothing', async () => {
    const token = await signUserToken('uuid-owner');
    selectLimit.mockResolvedValueOnce([{ emailVerifiedAt: new Date() }]);
    projectAccess.mockResolvedValueOnce(access('admin', 'owner'));
    updateReturning.mockResolvedValueOnce([patchedRow({ baseBranch: 'dev', releaseChain: [] })]);
    selectLimit.mockResolvedValueOnce([{ baseBranch: 'main', releaseChain: [] }]);

    const res = await req(`/${PID}`, {
      method: 'PATCH',
      body: JSON.stringify({ baseBranch: 'dev' }),
      token,
    });

    expect(res.status).toBe(200);
    expect(updateSet).toHaveBeenCalledWith({ baseBranch: 'dev' });
  });

  it('branch-config resolves no live branch for a chain that crosses nothing', async () => {
    const token = await signUserToken('uuid-user');
    projectAccess.mockResolvedValueOnce(access('member'));
    selectLimit
      .mockResolvedValueOnce([{ emailVerifiedAt: new Date() }])
      .mockResolvedValueOnce([{ baseBranch: 'develop', releaseChain: [{ branch: 'develop' }] }])
      .mockResolvedValueOnce([{ id: IID, sessionContext: null }]);

    const res = await req(`/${PID}/issues/${IID}/branch-config`, { token });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { baseBranch: string; liveBranch: string | null };
    expect(body.baseBranch).toBe('develop');
    expect(body.liveBranch).toBeNull();
  });
});

describe('PATCH /api/projects/:id — the retired agentConfig door', () => {
  it('refuses an agentConfig write naming the old pipeline config, and writes nothing', async () => {
    const token = await signUserToken('uuid-owner');
    selectLimit.mockResolvedValueOnce([{ emailVerifiedAt: new Date() }]);
    projectAccess.mockResolvedValueOnce(access('admin', 'owner'));
    const res = await req('/11111111-1111-4111-8111-111111111111', {
      method: 'PATCH',
      body: JSON.stringify({ agentConfig: { pipelineConfig: { statusEntryCriteria: {} } } }),
      token,
    });
    expect(res.status).toBe(400);
    expect(updateReturning).not.toHaveBeenCalled();
  });
});
