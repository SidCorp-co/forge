import { Hono, type MiddlewareHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db/client.js', () => ({ db: {} }));

vi.mock('../middleware/auth.js', () => ({
  requireAuth: (): MiddlewareHandler => async (c, next) => {
    const [principal, userId] = (c.req.header('authorization') ?? '')
      .replace('Bearer ', '')
      .split(':');
    if (!principal || !userId) throw new HTTPException(401, { message: 'invalid token' });
    c.set('userId', userId);
    c.set('principal', principal);
    await next();
  },
  assertEmailVerified: (): MiddlewareHandler => async (_c, next) => next(),
}));

vi.mock('../middleware/require-fresh-auth.js', () => ({
  requireFreshAuth: (): MiddlewareHandler => async (_c, next) => next(),
}));

vi.mock('../ws/server.js', () => ({ roomManager: { publish: vi.fn() } }));

const service = vi.hoisted(() => ({
  setPatFence: vi.fn(),
  listPatFenceChanges: vi.fn(),
}));
vi.mock('./fence-service.js', () => service);

const { patRoutes } = await import('./routes.js');
const { errorHandler } = await import('../middleware/error.js');

const app = new Hono();
app.route('/api', patRoutes);
app.onError(errorHandler as never);

const TOKEN = '6f1c2a9e-7b4d-4e21-9c1a-5d6e7f8a9b0c';
const PROJECT = '7f1c2a9e-7b4d-4e21-9c1a-5d6e7f8a9b0c';

const put = (auth: string, body: unknown) =>
  app.request(`/api/pat/${TOKEN}/fence`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${auth}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  service.setPatFence.mockReset();
});

describe('PUT /api/pat/:id/fence, who may call it', () => {
  it('refuses a token credential before reading the body or the token, PAT_FENCE_BY_TOKEN_FORBIDDEN', async () => {
    const res = await put('pat:u1', { boundProjectId: PROJECT, reason: 'widen myself' });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('PAT_FENCE_BY_TOKEN_FORBIDDEN');
    expect(service.setPatFence).not.toHaveBeenCalled();
  });

  it('hands a session caller to the service as the owner', async () => {
    service.setPatFence.mockResolvedValue({
      ok: false,
      refusals: [{ code: 'PAT_FENCE_UNCHANGED', path: '', detail: 'already' }],
    });
    const res = await put('user:u1', { boundProjectId: PROJECT, reason: 'same' });
    expect(res.status).toBe(422);
    expect(service.setPatFence).toHaveBeenCalledWith(
      expect.objectContaining({ tokenId: TOKEN, ownerId: 'u1', reason: 'same' }),
    );
  });

  it('answers 404 naming the token when the session holds no such token', async () => {
    service.setPatFence.mockResolvedValue(null);
    const res = await put('user:u2', { boundProjectId: PROJECT, reason: 'not mine' });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { message: string }).message).toContain(TOKEN);
  });

  it('answers a bad body 400 naming the valid shape', async () => {
    const res = await put('user:u1', {
      projectIds: [PROJECT],
      boundProjectId: PROJECT,
      reason: 'r',
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { message: string }).message).toContain('exactly one');
    expect(service.setPatFence).not.toHaveBeenCalled();
  });
});
