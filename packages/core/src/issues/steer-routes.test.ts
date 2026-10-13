/**
 * What the steer route answers when the comment it posts is refused. The refusals belong to the
 * caller's text, so each is a 400 naming its code; before they were mapped each surfaced as a 500.
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
  restActor: () => ({ type: 'user', id: 'user-1', agency: 'human' }),
}));

vi.mock('../db/client.js', () => ({
  db: {
    select: () => ({
      from: () => ({ where: () => ({ limit: async () => [{ projectId: 'project-1' }] }) }),
    }),
  },
}));

vi.mock('../lib/authz.js', () => ({
  loadProjectAccess: async () => ({}),
  assertProjectRole: () => undefined,
}));

const steerIssue = vi.fn();
vi.mock('../agent-sessions/steer-session.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../agent-sessions/steer-session.js')>()),
  steerIssue: (...args: unknown[]) => steerIssue(...args),
}));

const { issueSteerRoutes } = await import('./steer-routes.js');
const { SteerError } = await import('../agent-sessions/steer-session.js');
const { BodyInvalidError } = await import('../body/errors.js');
const { MessageRefusedError } = await import('../messaging/contract.js');
const { errorHandler } = await import('../middleware/error.js');
const { requestId } = await import('../middleware/request-id.js');

const ISSUE = '11111111-1111-4111-8111-111111111111';

async function steer(body: unknown) {
  const app = new Hono<{ Variables: import('../middleware/request-id.js').RequestIdVars }>();
  app.use('*', requestId());
  app.route('/api/issues', issueSteerRoutes);
  app.onError(errorHandler);
  const res = await app.request(`/api/issues/${ISSUE}/steer`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as { code?: string } };
}

beforeEach(() => {
  steerIssue.mockReset();
});

describe('POST /api/issues/:id/steer', () => {
  it('answers the steer it made', async () => {
    steerIssue.mockResolvedValue({
      agentSessionId: 's',
      jobId: 'j',
      commentId: 'c',
      seq: 1,
      duplicate: false,
    });
    const res = await steer({ body: 'look at the failing test' });
    expect(res.status).toBe(200);
  });

  it('refuses a text the comment body door cannot read with 400 BODY_INVALID', async () => {
    steerIssue.mockRejectedValue(new BodyInvalidError('the body is empty'));
    expect(await steer({ body: 'x' })).toMatchObject({
      status: 400,
      body: { code: 'BODY_INVALID' },
    });
  });

  it('refuses a text the message door refuses with 400 MESSAGE_REFUSED', async () => {
    steerIssue.mockRejectedValue(new MessageRefusedError('comment-write', []));
    expect(await steer({ body: 'x' })).toMatchObject({
      status: 400,
      body: { code: 'MESSAGE_REFUSED' },
    });
  });

  it('still names a missing live session', async () => {
    steerIssue.mockRejectedValue(new SteerError('NO_LIVE_SESSION', 'no live agent session'));
    expect(await steer({ body: 'x' })).toMatchObject({
      status: 404,
      body: { code: 'NO_LIVE_SESSION' },
    });
  });

  it('does not turn an unexpected failure into a 400', async () => {
    steerIssue.mockRejectedValue(new Error('boom'));
    expect((await steer({ body: 'x' })).status).toBe(500);
  });

  it('refuses an empty text before steering at all', async () => {
    expect((await steer({ body: '   ' })).status).toBe(400);
    expect(steerIssue).not.toHaveBeenCalled();
  });
});
