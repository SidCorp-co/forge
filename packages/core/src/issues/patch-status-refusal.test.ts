import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { errorHandler } from '../middleware/error.js';

vi.mock('../middleware/auth.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../middleware/auth.js')>();
  return {
    ...real,
    requireAuth:
      () => async (c: { set: (k: string, v: string) => void }, next: () => Promise<void>) => {
        c.set('userId', 'u1');
        await next();
      },
    assertEmailVerified: () => async (_c: unknown, next: () => Promise<void>) => next(),
  };
});

const { issueRoutes } = await import('./routes.js');

const ID = '00000000-0000-4000-8000-000000000001';

async function patch(body: unknown) {
  const a = new Hono().route('/api/issues', issueRoutes);
  a.onError(errorHandler as never);
  const res = await a.request(`/api/issues/${ID}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

type Refusals = { refusals: { code: string; path: string; detail: string }[] };

describe('PATCH /api/issues/:id with a status (R-1)', () => {
  for (const key of ['status', 'toStatus']) {
    it(`refuses \`${key}\` naming the transition route that moves it`, async () => {
      const res = await patch({ [key]: 'in_progress', plan: 'p' });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('STATUS_MOVES_BY_TRANSITION');
      const [row] = (res.body.error as Refusals).refusals;
      expect(row?.path).toBe(`/${key}`);
      expect(row?.detail).toContain('POST /api/issues/:id/transition');
      expect(row?.detail).toContain('toStatus');
    });
  }

  it('names every other key it refuses beside the status', async () => {
    const res = await patch({ status: 'open', colour: 'red' });
    const rows = (res.body.error as Refusals).refusals;
    expect(rows.map((r) => [r.code, r.path])).toEqual([
      ['STATUS_MOVES_BY_TRANSITION', '/status'],
      ['BAD_REQUEST', '/colour'],
    ]);
  });

  it('leaves an unknown key that is not a status to the shared answer', async () => {
    const res = await patch({ colour: 'red' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('BAD_REQUEST');
  });
});
