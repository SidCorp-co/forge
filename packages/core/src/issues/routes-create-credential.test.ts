// ISS-1374 — the REST create resolves the credential BEFORE it writes anything, so a request the gate
// recorded no principal on is refused and no row is created. The credential's own derivation is
// `middleware/rest-credential.test.ts`'s; the real doors are the integration test's.

import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../config/env.js', () => ({
  env: { JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef', NODE_ENV: 'test' },
}));
vi.mock('../db/client.js', () => ({ db: {} }));

// The gate is bypassed so the handler is reached with whatever the test sets; the credential and
// agency readers stay the real ones, which is the thing under test.
vi.mock('../middleware/auth.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../middleware/auth.js')>()),
  requireAuth: () => async (_c: unknown, next: () => Promise<void>) => next(),
  assertEmailVerified: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));

const createIssue = vi.fn();
vi.mock('./create-service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./create-service.js')>()),
  createIssue: (...a: unknown[]) => createIssue(...a),
}));
vi.mock('../lib/authz.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/authz.js')>()),
  loadProjectAccess: async () => ({ role: 'member' }),
  assertProjectRole: () => undefined,
}));

const { issueProjectRoutes } = await import('./routes.js');
const { errorHandler } = await import('../middleware/error.js');

const PROJECT_ID = '22222222-2222-4222-8222-222222222222';
const USER_ID = '33333333-3333-4333-8333-333333333333';
const TOKEN_ID = '66666666-6666-4666-8666-666666666666';

function appWith(vars: Record<string, string>) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    for (const [k, v] of Object.entries(vars)) c.set(k as never, v as never);
    await next();
  });
  app.route('/api/projects', issueProjectRoutes);
  app.onError(errorHandler as unknown as Parameters<typeof app.onError>[0]);
  return app;
}

function post(app: Hono) {
  return app.request(`/api/projects/${PROJECT_ID}/issues`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'a title', priority: 'low' }),
  });
}

beforeEach(() => {
  createIssue.mockReset();
  createIssue.mockRejectedValue(new Error('stop: the write is not under test'));
});

describe('POST /projects/:id/issues — the credential is named before any write', () => {
  it('refuses a request with no principal and never reaches createIssue', async () => {
    const res = await post(appWith({ userId: USER_ID, agency: 'human' }));
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).toContain('restCredential: no principal');
    expect(createIssue).not.toHaveBeenCalled();
  });

  it('hands createIssue the channel and the token the gate recorded, not web', async () => {
    await post(
      appWith({ userId: USER_ID, agency: 'agent', principal: 'pat', patTokenId: TOKEN_ID }),
    );
    expect(createIssue).toHaveBeenCalledTimes(1);
    expect(createIssue.mock.calls[0]?.[1]).toMatchObject({
      createdById: USER_ID,
      createdVia: 'pat',
      createdViaTokenId: TOKEN_ID,
    });
  });
});
