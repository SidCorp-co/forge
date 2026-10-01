import type { MiddlewareHandler } from 'hono';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const QUESTION = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const TOKEN = '33333333-3333-4333-8333-333333333333';

const as = vi.hoisted(() => ({
  principal: 'user' as 'user' | 'pat',
  agency: 'human' as 'human' | 'agent',
  tokenName: 'laptop',
}));

vi.mock('../middleware/auth.js', () => ({
  requireAuth: (): MiddlewareHandler => async (c, next) => {
    c.set('userId', USER);
    c.set('principal', as.principal);
    c.set('agency', as.agency);
    if (as.principal === 'pat') {
      c.set('patTokenId', TOKEN);
      if (as.agency === 'agent') c.set('agentUserId', USER);
    }
    await next();
  },
  assertEmailVerified: (): MiddlewareHandler => async (_c, next) => next(),
}));

vi.mock('../db/client.js', () => ({
  db: {
    select: () => ({
      from: () => ({ where: () => ({ limit: async () => [{ name: as.tokenName }] }) }),
    }),
  },
}));

const answerAs = vi.fn(async () => ({ ok: true }));
vi.mock('./read.js', () => ({
  answerAs,
  askAs: vi.fn(),
  decodeCursor: () => null,
  projectQuestionsFor: vi.fn(),
  readQuestionFor: vi.fn(async () => ({ blockerKind: 'master_or_peer' })),
  readQuestionsForIssue: vi.fn(),
}));

const { questionRoutes } = await import('./routes.js');

const answer = () => {
  const app = new Hono();
  app.route('/api/questions', questionRoutes);
  return app.request(`/api/questions/${QUESTION}/answer`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ optionId: 'approve', round: 1 }),
  });
};

beforeEach(() => answerAs.mockClear());

// ISS-34 — the door an answer came through is read off its credential, as a channel act's is.
describe('POST /api/questions/:id/answer records the door it came through', () => {
  it('records web for a session', async () => {
    Object.assign(as, { principal: 'user', agency: 'human' });
    expect((await answer()).status).toBe(200);
    expect(answerAs).toHaveBeenCalledWith(expect.objectContaining({ via: 'web' }));
  });

  it('records cli for a personal access token', async () => {
    Object.assign(as, { principal: 'pat', agency: 'agent', tokenName: 'runner box' });
    expect((await answer()).status).toBe(200);
    expect(answerAs).toHaveBeenCalledWith(expect.objectContaining({ via: 'cli' }));
  });

  it('records assistant for a chat turn token', async () => {
    Object.assign(as, { principal: 'pat', agency: 'agent', tokenName: 'turn:abc' });
    expect((await answer()).status).toBe(200);
    expect(answerAs).toHaveBeenCalledWith(expect.objectContaining({ via: 'assistant' }));
  });
});
