import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { errorHandler } from '../middleware/error.js';

const state = vi.hoisted(() => ({ answered: [] as Record<string, unknown>[] }));

vi.mock('../middleware/auth.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../middleware/auth.js')>();
  return {
    ...real,
    requireAuth:
      () => async (c: { set: (k: string, v: string) => void }, next: () => Promise<void>) => {
        c.set('userId', 'u1');
        c.set('agency', 'human');
        c.set('principal', 'session');
        await next();
      },
    assertEmailVerified: () => async (_c: unknown, next: () => Promise<void>) => next(),
    restActor: () => ({ agency: 'human' }),
  };
});
vi.mock('./ports.js', () => ({ doorOfRequest: async () => 'web' }));
vi.mock('./read.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  answerAs: async (input: Record<string, unknown>) => {
    state.answered.push(input);
    return { ok: true };
  },
}));

const { questionRoutes } = await import('./routes.js');

const Q = '00000000-0000-4000-8000-000000000003';

async function answer(body: unknown) {
  const a = new Hono().route('/api/questions', questionRoutes);
  a.onError(errorHandler as never);
  const res = await a.request(`/api/questions/${Q}/answer`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

type Rows = { refusals: { code: string; path: string; detail: string }[] };
const pathsOf = (body: Record<string, unknown>) =>
  (body.error as Rows).refusals.map((r) => r.path).sort();

beforeEach(() => {
  state.answered = [];
});

describe('POST /api/questions/:id/answer names every fault of its body at once (R-9)', () => {
  it('a body missing round and both answers is refused once, naming each, with the valid shape', async () => {
    const res = await answer({});
    expect(res.status).toBe(400);
    expect(pathsOf(res.body)).toEqual(['/optionId', '/round']);
    expect(String(res.body.detail)).toContain('exactly one of optionId');
    expect(state.answered).toEqual([]);
  });

  it('an unknown key is refused by name, never stripped', async () => {
    const res = await answer({ round: 1, answer: 'yes' });
    expect(res.status).toBe(400);
    const rows = (res.body.error as Rows).refusals;
    expect(rows.some((r) => r.detail.includes('answer'))).toBe(true);
    expect(state.answered).toEqual([]);
  });

  it('both optionId and text is refused naming text', async () => {
    const res = await answer({ round: 1, optionId: 'a', text: 'free' });
    expect(res.status).toBe(400);
    expect(pathsOf(res.body)).toEqual(['/text']);
  });

  it('a whitespace-only text is no answer', async () => {
    const res = await answer({ round: 1, text: '   ' });
    expect(res.status).toBe(400);
    expect(pathsOf(res.body)).toEqual(['/optionId']);
  });

  it('a body with round and one answer reaches the answer', async () => {
    const res = await answer({ round: 2, optionId: 'a' });
    expect(res.status).toBe(200);
    expect(state.answered[0]).toMatchObject({
      answer: { kind: 'option', optionId: 'a' },
      round: 2,
    });
  });
});
