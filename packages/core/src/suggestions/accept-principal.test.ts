import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { errorHandler } from '../middleware/error.js';

const state = vi.hoisted(() => ({
  device: undefined as string | undefined,
  accepted: [] as { actor: Record<string, unknown> }[],
}));

vi.mock('../middleware/auth.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../middleware/auth.js')>();
  return {
    ...real,
    requireAuth:
      () =>
      async (c: { set: (k: string, v: string) => void }, next: () => Promise<void>) => {
        c.set('userId', 'u1');
        c.set('agency', 'agent');
        if (state.device) c.set('patDeviceId', state.device);
        await next();
      },
    assertEmailVerified: () => async (_c: unknown, next: () => Promise<void>) => next(),
  };
});
vi.mock('./service.js', () => ({
  acceptSuggestion: async (input: { actor: Record<string, unknown> }) => {
    state.accepted.push(input);
    return { ok: false, refusals: [{ code: 'SUGGESTION_REFUSED', path: '', detail: 'probe' }] };
  },
  createSuggestion: vi.fn(),
  rejectSuggestion: vi.fn(),
  reviseSuggestion: vi.fn(),
  withdrawSuggestion: vi.fn(),
}));

const { suggestionRoutes } = await import('./routes.js');

const PROJECT = '00000000-0000-4000-8000-000000000001';
const SUGGESTION = '00000000-0000-4000-8000-000000000002';

async function accept() {
  const a = new Hono().route('/api/projects', suggestionRoutes);
  a.onError(errorHandler as never);
  await a.request(`/api/projects/${PROJECT}/suggestions/${SUGGESTION}/accept`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ reason: 'the plan' }),
  });
}

beforeEach(() => {
  state.accepted = [];
  state.device = undefined;
});

describe('a REST accept carries the principal that made it (R-8)', () => {
  it("names the paired box whose credential accepted, as a REST create's createdByDeviceId does", async () => {
    state.device = 'device-7';
    await accept();
    expect(state.accepted[0]?.actor).toEqual({ userId: 'u1', agency: 'agent', deviceId: 'device-7' });
  });

  it("names no box for an account's own credential", async () => {
    await accept();
    expect(state.accepted[0]?.actor).toEqual({ userId: 'u1', agency: 'agent', deviceId: null });
  });
});
