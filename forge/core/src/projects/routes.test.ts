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

vi.mock('../db/client.js', () => ({
  db: {
    select: vi.fn(() => ({ from: selectFrom })),
    transaction,
    update: dbUpdate,
    delete: dbDelete,
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

    expect(txInsertProjectValues).toHaveBeenCalledWith({
      slug: 'my-proj',
      name: 'My Project',
      ownerId: 'uuid-owner',
    });
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

  it('200 with project + members + labels for member', async () => {
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
          agentConfig: null,
          webhookSecret: null,
          createdAt: new Date('2026-04-01T00:00:00Z'),
        },
      ]);
    // First 4 selectWhere calls go through .limit() (auth + 3 lookups);
    // last 2 (members + labels list) await selectWhere directly.
    selectWhere
      .mockReturnValueOnce({ limit: selectLimit })
      .mockReturnValueOnce({ limit: selectLimit })
      .mockReturnValueOnce({ limit: selectLimit })
      .mockReturnValueOnce({ limit: selectLimit })
      .mockResolvedValueOnce([{ userId: 'uuid-user', role: 'owner' }])
      .mockResolvedValueOnce([{ id: 'l1', name: 'bug', color: '#f00' }]);

    const res = await req('/11111111-1111-4111-8111-111111111111', { token });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      id: string;
      members: unknown[];
      labels: unknown[];
    };
    expect(body.id).toBe('p1');
    expect(body.members).toHaveLength(1);
    expect(body.labels).toHaveLength(1);
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
