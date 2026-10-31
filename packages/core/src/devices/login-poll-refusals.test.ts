import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { errorHandler } from '../middleware/error.js';

const state = vi.hoisted(() => ({
  row: null as null | { consumedAt: Date | null; expiresAt: Date },
}));

vi.mock('./service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./service.js')>()),
  consumeLoginCode: async () => null,
}));
vi.mock('./read.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./read.js')>()),
  loginCodeState: async () => state.row,
}));

const { deviceLoginRoutes } = await import('./login-routes.js');

const poll = () => {
  // biome-ignore lint/suspicious/noExplicitAny: the routes' AuthVars carry more than a test sets
  const app = new Hono<any>().route('/', deviceLoginRoutes);
  app.onError(errorHandler as never);
  return app.request('/login/poll?pairing_code=ABC-DEFG');
};

type Body = { code: string; error: { code: string; refusals: { code: string }[] } };

describe('GET /login/poll: a pairing code that cannot be polled', () => {
  beforeEach(() => {
    state.row = null;
  });

  it('unknown is PAIRING_CODE_GONE, 404, in the envelope', async () => {
    const res = await poll();
    expect(res.status).toBe(404);
    const body = (await res.json()) as Body;
    expect(body.error.code).toBe('PAIRING_CODE_GONE');
    expect(body.code).toBe('PAIRING_CODE_GONE');
    expect(body.error.refusals[0]?.code).toBe('PAIRING_CODE_GONE');
  });

  it('consumed is PAIRING_CODE_CONSUMED, 409', async () => {
    state.row = { consumedAt: new Date(), expiresAt: new Date(Date.now() + 60_000) };
    const res = await poll();
    expect(res.status).toBe(409);
    expect(((await res.json()) as Body).error.code).toBe('PAIRING_CODE_CONSUMED');
  });

  it('expired is PAIRING_CODE_EXPIRED, 422', async () => {
    state.row = { consumedAt: null, expiresAt: new Date(Date.now() - 1000) };
    const res = await poll();
    expect(res.status).toBe(422);
    expect(((await res.json()) as Body).error.code).toBe('PAIRING_CODE_EXPIRED');
  });

  it('pending is still 204, never a refusal', async () => {
    state.row = { consumedAt: null, expiresAt: new Date(Date.now() + 60_000) };
    expect((await poll()).status).toBe(204);
  });
});
