import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_SECRET = 'test-secret-at-least-32-chars-long-abcdef';

vi.mock('../config/env.js', () => ({
  env: { JWT_SECRET: TEST_SECRET, NODE_ENV: 'test' },
}));

// `where()` is also thenable in Drizzle (count queries skip `.limit()` and
// await the query builder directly). Each test pushes a result via
// whereResults.push(rows) for awaits-on-where and selectOrderByOffset for the
// list path.
const whereResults: unknown[][] = [];
const selectLimit = vi.fn();
const selectOrderByOffset = vi.fn();
const selectOrderByLimit = vi.fn(() => ({ offset: selectOrderByOffset }));
const selectOrderBy = vi.fn(() => ({ limit: selectOrderByLimit }));
const selectWhere = vi.fn(() => {
  return {
    limit: selectLimit,
    orderBy: selectOrderBy,
    // Lazy: only consume a queued result when the where() call is awaited
    // directly (not chained with .limit/.orderBy).
    then: (cb: (v: unknown) => unknown) => {
      const result = whereResults.shift() ?? [];
      return Promise.resolve(result).then(cb);
    },
  };
});
const selectFrom = vi.fn(() => ({ where: selectWhere }));
const insertReturning = vi.fn();
const insertValues = vi.fn(() => ({ returning: insertReturning }));
const updateReturning = vi.fn();
const updateWhere = vi.fn(() => ({ returning: updateReturning }));
const updateSet = vi.fn(() => ({ where: updateWhere }));
const deleteReturning = vi.fn();
const deleteWhere = vi.fn(() => ({ returning: deleteReturning }));

vi.mock('../db/client.js', () => ({
  db: {
    select: vi.fn(() => ({ from: selectFrom })),
    insert: vi.fn(() => ({ values: insertValues })),
    update: vi.fn(() => ({ set: updateSet })),
    delete: vi.fn(() => ({ where: deleteWhere })),
  },
}));

const { notificationRoutes } = await import('./routes.js');
const { signUserToken } = await import('../auth/jwt.js');
const { errorHandler } = await import('../middleware/error.js');
const { requestId } = await import('../middleware/request-id.js');
const hooksModule = await import('../pipeline/hooks.js');

function buildApp() {
  const app = new Hono<{ Variables: import('../middleware/request-id.js').RequestIdVars }>();
  app.use('*', requestId());
  app.route('/api/notifications', notificationRoutes);
  app.onError(errorHandler);
  return app;
}

const USER_ID = '11111111-1111-4111-8111-111111111111';
const NOTIF_ID = '22222222-2222-4222-8222-222222222222';
const PROJECT_ID = '33333333-3333-4333-8333-333333333333';

beforeEach(() => {
  vi.clearAllMocks();
  selectLimit.mockReset();
  selectOrderByOffset.mockReset();
  insertReturning.mockReset();
  updateReturning.mockReset();
  deleteReturning.mockReset();
  hooksModule.hooks.reset();
  whereResults.length = 0;
});

function authVerified() {
  selectLimit.mockResolvedValueOnce([{ emailVerifiedAt: new Date() }]);
}

async function token() {
  return signUserToken(USER_ID);
}

describe('GET /api/notifications/unread-count', () => {
  it('401 without token', async () => {
    const res = await buildApp().request('/api/notifications/unread-count');
    expect(res.status).toBe(401);
  });

  it('returns count scoped to current user', async () => {
    authVerified();
    whereResults.push([{ n: 7 }]);
    const res = await buildApp().request('/api/notifications/unread-count', {
      headers: { authorization: `Bearer ${await token()}` },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ count: 7 });
  });
});

describe('GET /api/notifications', () => {
  it('returns scoped list with X-Total-Count', async () => {
    authVerified();
    whereResults.push([{ n: 2 }]);
    selectOrderByOffset.mockResolvedValueOnce([
      { id: NOTIF_ID, userId: USER_ID, type: 'mention', title: 't', read: false },
    ]);
    const res = await buildApp().request('/api/notifications', {
      headers: { authorization: `Bearer ${await token()}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('X-Total-Count')).toBe('2');
    expect(await res.json()).toHaveLength(1);
  });

  it('rejects bad projectId', async () => {
    authVerified();
    const res = await buildApp().request('/api/notifications?projectId=not-a-uuid', {
      headers: { authorization: `Bearer ${await token()}` },
    });
    expect(res.status).toBe(400);
  });
});

describe('POST /api/notifications/mark-all-read', () => {
  it('returns updated count and accepts optional projectId', async () => {
    authVerified();
    updateReturning.mockResolvedValueOnce([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
    const res = await buildApp().request('/api/notifications/mark-all-read', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${await token()}` },
      body: JSON.stringify({ projectId: PROJECT_ID }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ updated: 3 });
  });
});

describe('PATCH /api/notifications/:id', () => {
  it('emits notificationRead when marking read', async () => {
    authVerified();
    updateReturning.mockResolvedValueOnce([
      { id: NOTIF_ID, userId: USER_ID, read: true, type: 'mention', title: 't' },
    ]);
    const seen: string[] = [];
    hooksModule.hooks.on('notificationRead', (p) => {
      seen.push(p.notificationId);
    });
    const res = await buildApp().request(`/api/notifications/${NOTIF_ID}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${await token()}` },
      body: JSON.stringify({ read: true }),
    });
    expect(res.status).toBe(200);
    expect(seen).toEqual([NOTIF_ID]);
  });

  it('404 when notification not owned by user', async () => {
    authVerified();
    updateReturning.mockResolvedValueOnce([]);
    const res = await buildApp().request(`/api/notifications/${NOTIF_ID}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${await token()}` },
      body: JSON.stringify({ read: true }),
    });
    expect(res.status).toBe(404);
  });
});

describe('DELETE /api/notifications/:id', () => {
  it('204 on success', async () => {
    authVerified();
    deleteReturning.mockResolvedValueOnce([{ id: NOTIF_ID }]);
    const res = await buildApp().request(`/api/notifications/${NOTIF_ID}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${await token()}` },
    });
    expect(res.status).toBe(204);
  });

  it('404 when not owned by user', async () => {
    authVerified();
    deleteReturning.mockResolvedValueOnce([]);
    const res = await buildApp().request(`/api/notifications/${NOTIF_ID}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${await token()}` },
    });
    expect(res.status).toBe(404);
  });
});

describe('createNotification helper + WS bridge', () => {
  it('emits notificationCreated which bridges to userRoom', async () => {
    // mention gate: preferences lookup returns no row → opted-in by default.
    selectLimit.mockResolvedValueOnce([]);
    insertReturning.mockResolvedValueOnce([{ id: NOTIF_ID }]);
    const seenUserIds: string[] = [];
    hooksModule.hooks.on('notificationCreated', (p) => {
      seenUserIds.push(p.userId);
    });
    const { createNotification } = await import('./routes.js');
    await createNotification({
      userId: USER_ID,
      type: 'mention',
      title: 'You were mentioned',
      projectId: PROJECT_ID,
    });
    expect(seenUserIds).toEqual([USER_ID]);
  });

  it('suppresses a mention when notify_on_mention is false', async () => {
    // mention gate: preferences row opts out → no insert, no emit, returns null.
    selectLimit.mockResolvedValueOnce([{ notifyOnMention: false }]);
    const seenUserIds: string[] = [];
    hooksModule.hooks.on('notificationCreated', (p) => {
      seenUserIds.push(p.userId);
    });
    const { createNotification } = await import('./routes.js');
    const result = await createNotification({
      userId: USER_ID,
      type: 'mention',
      title: 'You were mentioned',
      projectId: PROJECT_ID,
    });
    expect(result).toBeNull();
    expect(insertReturning).not.toHaveBeenCalled();
    expect(seenUserIds).toEqual([]);
  });
});
