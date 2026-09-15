import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_SECRET = 'test-secret-at-least-32-chars-long-abcdef';
vi.mock('../config/env.js', () => ({ env: { JWT_SECRET: TEST_SECRET, NODE_ENV: 'test' } }));

const selectLimit = vi.fn();
vi.mock('../db/client.js', () => ({
  db: { select: vi.fn(() => ({ from: () => ({ where: () => ({ limit: selectLimit }) }) })) },
}));
const listMine = vi.fn();
const deleteMine = vi.fn();
vi.mock('./mine-service.js', () => ({
  listMine: (...a: unknown[]) => listMine(...(a as [])),
  deleteMine: (...a: unknown[]) => deleteMine(...(a as [])),
}));

const { memoryMineRoutes } = await import('./mine-routes.js');
const { signUserToken } = await import('../auth/jwt.js');
const { errorHandler } = await import('../middleware/error.js');
const { requestId } = await import('../middleware/request-id.js');

const USER_ID = '11111111-1111-4111-8111-111111111111';
const NOTE_ID = '22222222-2222-4222-8222-222222222222';

function app() {
  const a = new Hono<{ Variables: import('../middleware/request-id.js').RequestIdVars }>();
  a.use('*', requestId());
  a.route('/api/memory', memoryMineRoutes);
  a.onError(errorHandler);
  return a;
}
async function authed(path: string, init: RequestInit = {}) {
  selectLimit.mockResolvedValueOnce([{ emailVerifiedAt: new Date() }]);
  return app().request(path, {
    ...init,
    headers: { authorization: `Bearer ${await signUserToken(USER_ID)}` },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  selectLimit.mockReset();
});

describe('GET /api/memory/mine', () => {
  it('401 without a token', async () => {
    expect((await app().request('/api/memory/mine')).status).toBe(401);
  });

  // cm:guard the caller's id is what reaches the service and the query names no user: the ONLY way to pick whose notes are listed is to be them (ISS-1034 criterion 28).
  it('lists the caller’s own notes, by the caller’s id', async () => {
    listMine.mockResolvedValue([{ id: NOTE_ID, textContent: 'deploys on Thursdays' }]);
    const res = await authed('/api/memory/mine?projectId=33333333-3333-4333-8333-333333333333');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      items: [{ id: NOTE_ID, textContent: 'deploys on Thursdays' }],
    });
    expect(listMine).toHaveBeenCalledWith(USER_ID, {
      projectId: '33333333-3333-4333-8333-333333333333',
    });
  });

  it('refuses a projectId that is not a uuid', async () => {
    expect((await authed('/api/memory/mine?projectId=nope')).status).toBe(400);
    expect(listMine).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/memory/mine/:id', () => {
  it('204 when the row was the caller’s', async () => {
    deleteMine.mockResolvedValue(true);
    const res = await authed(`/api/memory/mine/${NOTE_ID}`, { method: 'DELETE' });
    expect(res.status).toBe(204);
    expect(deleteMine).toHaveBeenCalledWith(USER_ID, NOTE_ID);
  });

  it('404 when no note of the caller’s has that id', async () => {
    deleteMine.mockResolvedValue(false);
    const res = await authed(`/api/memory/mine/${NOTE_ID}`, { method: 'DELETE' });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { code: string }).code).toBe('NOT_FOUND');
  });
});
