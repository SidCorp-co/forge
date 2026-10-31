import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { errorHandler } from '../middleware/error.js';

const state = vi.hoisted(() => ({
  org: null as null | { acceptedAt: Date | null; expiresAt: Date },
  project: null as null | { acceptedAt: Date | null; expiresAt: Date },
}));

vi.mock('./read.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./read.js')>()),
  orgInvitationByToken: async () => state.org,
}));
vi.mock('../projects/read.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../projects/read.js')>()),
  projectInvitationByToken: async () => state.project,
}));

const { orgInvitationRoutes } = await import('./invitations-routes.js');
const { invitationRoutes } = await import('../projects/invitations-routes.js');

const get = (door: 'org' | 'project') => {
  // biome-ignore lint/suspicious/noExplicitAny: the routes' AuthVars carry more than a test sets
  const app = new Hono<any>().route('/', door === 'org' ? orgInvitationRoutes : invitationRoutes);
  app.onError(errorHandler as never);
  return app.request('/some-token');
};

type Body = { code: string; error: { code: string; refusals: { code: string }[] } };
const future = () => new Date(Date.now() + 60_000);
const past = () => new Date(Date.now() - 60_000);

describe.each(['org', 'project'] as const)('GET /:token on the %s invitation door', (door) => {
  beforeEach(() => {
    state.org = null;
    state.project = null;
  });
  const hold = (row: { acceptedAt: Date | null; expiresAt: Date }) => {
    state[door] = row;
  };

  it('an accepted invitation is ALREADY_ACCEPTED, 409, in the envelope', async () => {
    hold({ acceptedAt: new Date(), expiresAt: future() });
    const res = await get(door);
    expect(res.status).toBe(409);
    const body = (await res.json()) as Body;
    expect(body.error.code).toBe('ALREADY_ACCEPTED');
    expect(body.code).toBe('ALREADY_ACCEPTED');
    expect(body.error.refusals[0]?.code).toBe('ALREADY_ACCEPTED');
  });

  it('an expired invitation is EXPIRED_TOKEN, 422', async () => {
    hold({ acceptedAt: null, expiresAt: past() });
    const res = await get(door);
    expect(res.status).toBe(422);
    expect(((await res.json()) as Body).error.code).toBe('EXPIRED_TOKEN');
  });

  it('an unknown token stays INVALID_TOKEN, 404', async () => {
    const res = await get(door);
    expect(res.status).toBe(404);
    expect(((await res.json()) as Body).error.code).toBe('INVALID_TOKEN');
  });
});
