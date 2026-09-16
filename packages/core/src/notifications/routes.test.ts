import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_SECRET = 'test-secret-at-least-32-chars-long-abcdef';

vi.mock('../config/env.js', () => ({
  env: { JWT_SECRET: TEST_SECRET, NODE_ENV: 'test' },
}));

/**
 * The read routes, against a chainable stub.
 *
 * ISS-1063 — what these cases can and cannot prove is worth stating, because the shape
 * changed underneath them. A stub that answers every query with the next queued array
 * proves the ROUTE's contract: its status codes, its scoping to the caller, which table
 * it writes, and the payload it returns. It cannot prove the SQL is right — a predicate
 * over `state` and a predicate over `read` look identical from here. That half is
 * `tests/integration/notification-record-kinds-e2e.test.ts`, against a real database
 * with real rows, and it is where every counting criterion is answered.
 */
const results: unknown[][] = [];
// biome-ignore lint/suspicious/noExplicitAny: chainable query-builder stub
const chain: any = {};
for (const method of [
  'from',
  'innerJoin',
  'leftJoin',
  'where',
  'groupBy',
  'orderBy',
  'limit',
  'offset',
]) {
  chain[method] = () => chain;
}
chain.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
  Promise.resolve(results.shift() ?? []).then(resolve, reject);

const insertReturning = vi.fn();
const insertValues = vi.fn(() => ({ returning: insertReturning }));
const updateReturning = vi.fn();
const updateWhere = vi.fn(() => ({ returning: updateReturning }));
const updateSet = vi.fn((_values: Record<string, unknown>) => ({ where: updateWhere }));
const deleteReturning = vi.fn();
const deleteWhere = vi.fn(() => ({ returning: deleteReturning }));

vi.mock('../db/client.js', () => ({
  db: {
    select: vi.fn(() => chain),
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
const DELIVERY_ID = '22222222-2222-4222-8222-222222222222';
const NOTIF_ID = '44444444-4444-4444-8444-444444444444';
const PROJECT_ID = '33333333-3333-4333-8333-333333333333';

beforeEach(() => {
  vi.clearAllMocks();
  insertReturning.mockReset();
  updateReturning.mockReset();
  deleteReturning.mockReset();
  hooksModule.hooks.reset();
  results.length = 0;
});

/** The `assertEmailVerified` lookup every authenticated route makes first. */
function authVerified() {
  results.push([{ emailVerifiedAt: new Date() }]);
}

async function token() {
  return signUserToken(USER_ID);
}

describe('GET /api/notifications/open-count', () => {
  it('401 without token', async () => {
    const res = await buildApp().request('/api/notifications/open-count');
    expect(res.status).toBe(401);
  });

  // cm:guard the old route is GONE, not redefined. A route named `unread-count` answering an open count is the silent substitution CLAUDE.md forbids — web-v2's caller moved in the same change, and this case is what says the old name stops answering.
  it('404 on the route it replaced', async () => {
    authVerified();
    const res = await buildApp().request('/api/notifications/unread-count', {
      headers: { authorization: `Bearer ${await token()}` },
    });
    expect(res.status).toBe(404);
  });

  it('returns the count scoped to the caller', async () => {
    authVerified();
    results.push([{ n: 7 }]);
    const res = await buildApp().request('/api/notifications/open-count', {
      headers: { authorization: `Bearer ${await token()}` },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ count: 7 });
  });
});

describe('GET /api/notifications', () => {
  it('returns one row per delivery with X-Total-Count', async () => {
    authVerified();
    results.push([{ n: 2 }]);
    results.push([
      {
        id: DELIVERY_ID,
        notificationId: NOTIF_ID,
        type: 'issue_stranded',
        kind: 'condition',
        title: '15 issues parked',
        readAt: null,
        members: 15,
        openMembers: 12,
      },
    ]);
    const res = await buildApp().request('/api/notifications', {
      headers: { authorization: `Bearer ${await token()}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('X-Total-Count')).toBe('2');
    expect(await res.json()).toMatchObject({ returned: 1, total: 2, hasMore: true });
  });

  it('rejects bad projectId', async () => {
    authVerified();
    const res = await buildApp().request('/api/notifications?projectId=not-a-uuid', {
      headers: { authorization: `Bearer ${await token()}` },
    });
    expect(res.status).toBe(400);
  });
});

describe('GET /api/notifications/:id/members', () => {
  it('404 when the delivery is not the caller’s', async () => {
    authVerified();
    results.push([]);
    const res = await buildApp().request(`/api/notifications/${DELIVERY_ID}/members`, {
      headers: { authorization: `Bearer ${await token()}` },
    });
    expect(res.status).toBe(404);
  });

  it('returns the records the delivery carries', async () => {
    authVerified();
    results.push([{ id: DELIVERY_ID }]);
    results.push([
      { id: NOTIF_ID, title: 'ISS-1 is parked', open: true },
      { id: 'b', title: 'ISS-2 is parked', open: false },
    ]);
    const res = await buildApp().request(`/api/notifications/${DELIVERY_ID}/members`, {
      headers: { authorization: `Bearer ${await token()}` },
    });
    expect(res.status).toBe(200);
    expect((await res.json()) as unknown[]).toHaveLength(2);
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
  // cm:guard this route writes `notification_deliveries` and NOTHING else — it is the one place a person's read state is written, and it must not be able to reach the record. `set` carrying anything but `readAt` is the regression: it would put "has a human looked" back on the row that says "is this still true", which is the defect ISS-1063 exists to end.
  it('writes only the delivery’s read state, and emits notificationRead', async () => {
    authVerified();
    updateReturning.mockResolvedValueOnce([{ id: DELIVERY_ID, userId: USER_ID }]);
    const seen: string[] = [];
    hooksModule.hooks.on('notificationRead', (p) => {
      seen.push(p.notificationId);
    });
    const res = await buildApp().request(`/api/notifications/${DELIVERY_ID}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${await token()}` },
      body: JSON.stringify({ read: true }),
    });
    expect(res.status).toBe(200);
    expect(seen).toEqual([DELIVERY_ID]);
    expect(Object.keys(updateSet.mock.calls[0]?.[0] ?? {})).toEqual(['readAt']);
  });

  it('marking unread clears the timestamp and announces nothing', async () => {
    authVerified();
    updateReturning.mockResolvedValueOnce([{ id: DELIVERY_ID, userId: USER_ID }]);
    const seen: string[] = [];
    hooksModule.hooks.on('notificationRead', (p) => {
      seen.push(p.notificationId);
    });
    const res = await buildApp().request(`/api/notifications/${DELIVERY_ID}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${await token()}` },
      body: JSON.stringify({ read: false }),
    });
    expect(res.status).toBe(200);
    expect(updateSet.mock.calls[0]?.[0]?.readAt).toBeNull();
    expect(seen).toEqual([]);
  });

  it('404 when the delivery is not the caller’s', async () => {
    authVerified();
    updateReturning.mockResolvedValueOnce([]);
    const res = await buildApp().request(`/api/notifications/${DELIVERY_ID}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${await token()}` },
      body: JSON.stringify({ read: true }),
    });
    expect(res.status).toBe(404);
  });
});

/**
 * Criterion 19 — no request a person can send resolves a condition.
 *
 * The two closing routes exist for tasks, and the UPDATE they issue is scoped to
 * `kind = 'task'`. A person may finish work; a person may not declare that a condition
 * stopped being true, because the next detector pass would raise it again and the count
 * would be a number people could change by looking at it.
 */
describe('POST /api/notifications/:id/done and /dismiss', () => {
  for (const [path, state] of [
    ['done', 'done'],
    ['dismiss', 'dismissed'],
  ] as const) {
    it(`${path} closes only the task records the delivery carries`, async () => {
      authVerified();
      results.push([{ id: DELIVERY_ID }]); // the delivery is the caller's
      results.push([{ id: NOTIF_ID }]); // its members
      updateReturning.mockResolvedValueOnce([{ id: NOTIF_ID }]);
      const res = await buildApp().request(`/api/notifications/${DELIVERY_ID}/${path}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${await token()}` },
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ closed: 1 });
      expect(updateSet).toHaveBeenCalledWith(expect.objectContaining({ state }));
    });
  }

  it('404 when the delivery is not the caller’s', async () => {
    authVerified();
    results.push([]);
    const res = await buildApp().request(`/api/notifications/${DELIVERY_ID}/done`, {
      method: 'POST',
      headers: { authorization: `Bearer ${await token()}` },
    });
    expect(res.status).toBe(404);
  });
});

describe('DELETE /api/notifications/:id', () => {
  it('204 on success', async () => {
    authVerified();
    deleteReturning.mockResolvedValueOnce([{ id: DELIVERY_ID }]);
    const res = await buildApp().request(`/api/notifications/${DELIVERY_ID}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${await token()}` },
    });
    expect(res.status).toBe(204);
  });

  it('404 when not owned by user', async () => {
    authVerified();
    deleteReturning.mockResolvedValueOnce([]);
    const res = await buildApp().request(`/api/notifications/${DELIVERY_ID}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${await token()}` },
    });
    expect(res.status).toBe(404);
  });
});
