import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_SECRET = 'test-secret-at-least-32-chars-long-abcdef';

vi.mock('../config/env.js', () => ({
  env: { JWT_SECRET: TEST_SECRET, NODE_ENV: 'test' },
}));

const selectLimit = vi.fn();
const selectWhereLimit = vi.fn(() => ({ limit: selectLimit }));
const innerJoin2Where = vi.fn(() => ({ limit: selectLimit }));
const innerJoin2 = vi.fn(() => ({ where: innerJoin2Where }));
const innerJoin1 = vi.fn(() => ({ innerJoin: innerJoin2 }));
const selectFrom = vi.fn(() => ({
  where: selectWhereLimit,
  innerJoin: innerJoin1,
}));

const updateReturning = vi.fn();
const updateWhere = vi.fn(() => ({ returning: updateReturning }));
const updateSet = vi.fn(() => ({ where: updateWhere }));

vi.mock('../db/client.js', () => ({
  db: {
    select: vi.fn(() => ({ from: selectFrom })),
    update: vi.fn(() => ({ set: updateSet })),
    transaction: vi.fn(),
  },
}));

const consumeOrgInvitationToken = vi.fn();
vi.mock('./invitations.js', () => ({
  consumeOrgInvitationToken,
}));

const { orgInvitationRoutes } = await import('./invitations-routes.js');
const { signUserToken } = await import('../auth/jwt.js');
const { errorHandler } = await import('../middleware/error.js');
const { requestId } = await import('../middleware/request-id.js');

function buildApp() {
  const app = new Hono<{
    Variables: import('../middleware/request-id.js').RequestIdVars;
  }>();
  app.use('*', requestId());
  app.route('/api/org-invitations', orgInvitationRoutes);
  app.onError(errorHandler);
  return app;
}

const USER_ID = '55555555-5555-4555-8555-555555555555';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('orgInvitationRoutes — GET /:token', () => {
  it('404 when token not found', async () => {
    selectLimit.mockResolvedValueOnce([]);
    const res = await buildApp().request('/api/org-invitations/missing-token');
    expect(res.status).toBe(404);
  });

  it('200 with org invite preview for valid pending token', async () => {
    selectLimit.mockResolvedValueOnce([
      {
        email: 'x@e.co',
        role: 'member',
        expiresAt: new Date(Date.now() + 10000),
        acceptedAt: null,
        orgName: 'Acme Corp',
        inviterEmail: 'owner@e.co',
      },
    ]);
    const res = await buildApp().request('/api/org-invitations/tok');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { orgName: string };
    expect(body.orgName).toBe('Acme Corp');
  });
});

describe('orgInvitationRoutes — POST /:token/accept', () => {
  it('401 without auth', async () => {
    const res = await buildApp().request('/api/org-invitations/tok/accept', { method: 'POST' });
    expect(res.status).toBe(401);
  });

  it('200 on successful accept', async () => {
    const token = await signUserToken(USER_ID);
    selectLimit.mockResolvedValueOnce([{ id: USER_ID, email: 'u@e.co' }]);
    consumeOrgInvitationToken.mockResolvedValueOnce({
      status: 'ok',
      orgId: '22222222-2222-4222-8222-222222222222',
      role: 'member',
    });

    const res = await buildApp().request('/api/org-invitations/tok/accept', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { orgId: string; role: string };
    expect(body.role).toBe('member');
  });
});

describe('orgInvitationRoutes — POST /:token/decline', () => {
  it('401 without auth', async () => {
    const res = await buildApp().request('/api/org-invitations/tok/decline', { method: 'POST' });
    expect(res.status).toBe(401);
  });

  it('200 dismissed:true on valid token + email match', async () => {
    const authToken = await signUserToken(USER_ID);
    selectLimit.mockResolvedValueOnce([{ email: 'user@example.com' }]);
    updateReturning.mockResolvedValueOnce([{ token: 'org-token-abc' }]);

    const res = await buildApp().request('/api/org-invitations/org-token-abc/decline', {
      method: 'POST',
      headers: { authorization: `Bearer ${authToken}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { dismissed: boolean };
    expect(body.dismissed).toBe(true);
  });

  it('404 when token not found or email mismatch', async () => {
    const authToken = await signUserToken(USER_ID);
    selectLimit.mockResolvedValueOnce([{ email: 'user@example.com' }]);
    updateReturning.mockResolvedValueOnce([]);

    const res = await buildApp().request('/api/org-invitations/wrong-token/decline', {
      method: 'POST',
      headers: { authorization: `Bearer ${authToken}` },
    });
    expect(res.status).toBe(404);
  });
});
