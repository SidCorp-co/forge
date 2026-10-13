/**
 * `POST /api/notifications/mark-all-read` marks every unread notification of the caller read, so a
 * body that names a project cannot be honoured and is refused by name instead of being ignored.
 */

import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../config/env.js', () => ({
  env: { JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef', NODE_ENV: 'test' },
}));

vi.mock('../middleware/auth.js', () => ({
  requireAuth:
    () => async (c: { set: (k: string, v: string) => void }, next: () => Promise<void>) => {
      c.set('userId', 'user-1');
      await next();
    },
  assertEmailVerified: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));

const returning = vi.fn();
vi.mock('../db/client.js', () => ({
  db: { update: () => ({ set: () => ({ where: () => ({ returning }) }) }) },
}));

const { notificationRoutes } = await import('./routes.js');
const { errorHandler } = await import('../middleware/error.js');
const { requestId } = await import('../middleware/request-id.js');

async function markAllRead(body: unknown) {
  const app = new Hono<{ Variables: import('../middleware/request-id.js').RequestIdVars }>();
  app.use('*', requestId());
  app.route('/api/notifications', notificationRoutes);
  app.onError(errorHandler);
  const res = await app.request('/api/notifications/mark-all-read', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

beforeEach(() => {
  returning.mockReset();
  returning.mockResolvedValue([{ id: 'a' }, { id: 'b' }]);
});

describe('POST /api/notifications/mark-all-read', () => {
  it('marks every unread delivery read and says how many', async () => {
    expect(await markAllRead({})).toEqual({ status: 200, body: { updated: 2 } });
  });

  it('says zero when nothing was unread', async () => {
    returning.mockResolvedValue([]);
    expect(await markAllRead({})).toEqual({ status: 200, body: { updated: 0 } });
  });

  it('refuses a projectId by name, because it would not narrow the update', async () => {
    const res = await markAllRead({ projectId: '11111111-1111-4111-8111-111111111111' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('BAD_REQUEST');
    expect(JSON.stringify(res.body)).toContain('projectId');
    expect(returning).not.toHaveBeenCalled();
  });
});
