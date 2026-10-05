import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const bound = vi.fn();
const inserted = vi.fn();

vi.mock('../middleware/auth.js', async (orig) => ({
  ...(await orig<typeof import('../middleware/auth.js')>()),
  requireAuth:
    () => async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
      c.set('userId', 'user-a');
      c.set('principal', 'user');
      await next();
    },
  assertEmailVerified: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));
vi.mock('../lib/authz.js', () => ({ loadProjectAccess: vi.fn(async () => ({})) }));
vi.mock('../permissions/index.js', async (orig) => ({
  ...(await orig<typeof import('../permissions/index.js')>()),
  requireHeld: vi.fn(),
}));
vi.mock('../db/client.js', () => {
  const chain = {
    select: () => chain,
    from: () => chain,
    where: () => chain,
    limit: async () => [
      { id: DEVICE, ownerId: 'user-b', name: 'box', status: 'online', lastSeenAt: new Date() },
    ],
  };
  return { db: chain };
});
vi.mock('./writes.js', async (orig) => ({
  ...(await orig<typeof import('./writes.js')>()),
  upsertDeviceRunner: bound,
}));
vi.mock('./service.js', async (orig) => ({
  ...(await orig<typeof import('./service.js')>()),
  insertRunner: inserted,
}));

const DEVICE = '00000000-0000-4000-8000-0000000000d1';
const PROJECT = '00000000-0000-4000-8000-0000000000a1';

const { projectRunnerRoutes } = await import('./project-routes.js');
const { runnerRoutes } = await import('./routes.js');

function app(): Hono {
  const a = new Hono();
  a.onError((err, c) => {
    const status = err instanceof HTTPException ? err.status : 500;
    const code = (err as { cause?: { code?: string } }).cause?.code ?? null;
    return c.json({ code, error: err.message }, status);
  });
  a.route('/api/projects', projectRunnerRoutes);
  a.route('/api/runners', runnerRoutes);
  return a;
}

describe('a project admin cannot bind a device somebody else owns', () => {
  beforeEach(() => {
    bound.mockReset();
    inserted.mockReset();
  });

  it('POST /api/projects/:id/runners refuses DEVICE_NOT_OWNED', async () => {
    const res = await app().request(`/api/projects/${PROJECT}/runners`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceId: DEVICE }),
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe('DEVICE_NOT_OWNED');
    expect(bound).not.toHaveBeenCalled();
  });

  it('POST /api/runners refuses DEVICE_NOT_OWNED', async () => {
    const res = await app().request('/api/runners', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: PROJECT,
        type: 'claude-code',
        name: 'r',
        deviceId: DEVICE,
      }),
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe('DEVICE_NOT_OWNED');
    expect(inserted).not.toHaveBeenCalled();
  });
});
