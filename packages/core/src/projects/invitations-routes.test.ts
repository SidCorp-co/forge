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

const consumeInvitationToken = vi.fn();
vi.mock('./invitation-token.js', () => ({
  consumeInvitationToken,
}));

const { invitationRoutes } = await import('./invitations-routes.js');
const { signUserToken } = await import('../auth/jwt.js');
const { errorHandler } = await import('../middleware/error.js');
const { requestId } = await import('../middleware/request-id.js');

function buildApp() {
  const app = new Hono<{
    Variables: import('../middleware/request-id.js').RequestIdVars;
  }>();
  app.use('*', requestId());
  app.route('/api/invitations', invitationRoutes);
  app.onError(errorHandler);
  return app;
}

const USER_ID = '44444444-4444-4444-8444-444444444444';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('invitationRoutes — GET /:token', () => {
  it('404 when token not found', async () => {
    selectLimit.mockResolvedValueOnce([]);
    const res = await buildApp().request('/api/invitations/missing-token');
    expect(res.status).toBe(404);
  });

  it('410 ALREADY_ACCEPTED when invite already consumed', async () => {
    selectLimit.mockResolvedValueOnce([
      {
        email: 'x@e.co',
        role: 'member',
        expiresAt: new Date(Date.now() + 10000),
        acceptedAt: new Date(),
        projectName: 'p',
        inviterEmail: 'o@e.co',
      },
    ]);
    const res = await buildApp().request('/api/invitations/tok');
    expect(res.status).toBe(410);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('ALREADY_ACCEPTED');
  });

  it('410 EXPIRED_TOKEN when past expiry', async () => {
    selectLimit.mockResolvedValueOnce([
      {
        email: 'x@e.co',
        role: 'member',
        expiresAt: new Date(Date.now() - 1000),
        acceptedAt: null,
        projectName: 'p',
        inviterEmail: 'o@e.co',
      },
    ]);
    const res = await buildApp().request('/api/invitations/tok');
    expect(res.status).toBe(410);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('EXPIRED_TOKEN');
  });

  it('200 with invite preview for valid pending token', async () => {
    selectLimit.mockResolvedValueOnce([
      {
        email: 'x@e.co',
        role: 'member',
        expiresAt: new Date(Date.now() + 10000),
        acceptedAt: null,
        projectName: 'Acme',
        inviterEmail: 'owner@e.co',
      },
    ]);
    const res = await buildApp().request('/api/invitations/tok');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { projectName: string; inviterEmail: string };
    expect(body.projectName).toBe('Acme');
    expect(body.inviterEmail).toBe('owner@e.co');
  });
});

describe('invitationRoutes — POST /:token/accept', () => {
  it('401 without auth', async () => {
    const res = await buildApp().request('/api/invitations/tok/accept', { method: 'POST' });
    expect(res.status).toBe(401);
  });

  it('200 on successful accept', async () => {
    const token = await signUserToken(USER_ID);
    // user lookup
    selectLimit.mockResolvedValueOnce([{ id: USER_ID, email: 'u@e.co' }]);
    consumeInvitationToken.mockResolvedValueOnce({
      status: 'ok',
      projectId: '11111111-1111-4111-8111-111111111111',
      role: 'member',
    });

    const res = await buildApp().request('/api/invitations/tok/accept', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { projectId: string; role: string };
    expect(body.role).toBe('member');
  });

  it('403 INVITATION_EMAIL_MISMATCH when invite was sent to a different email', async () => {
    const token = await signUserToken(USER_ID);
    selectLimit.mockResolvedValueOnce([{ id: USER_ID, email: 'u@e.co' }]);
    consumeInvitationToken.mockResolvedValueOnce({
      status: 'email_mismatch',
      invitedEmail: 'other@e.co',
    });

    const res = await buildApp().request('/api/invitations/tok/accept', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('INVITATION_EMAIL_MISMATCH');
  });

  it('410 EXPIRED_TOKEN', async () => {
    const token = await signUserToken(USER_ID);
    selectLimit.mockResolvedValueOnce([{ id: USER_ID, email: 'u@e.co' }]);
    consumeInvitationToken.mockResolvedValueOnce({ status: 'expired' });

    const res = await buildApp().request('/api/invitations/tok/accept', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(410);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('EXPIRED_TOKEN');
  });
});

describe('invitationRoutes — GET /pending', () => {
  it('401 without auth', async () => {
    const res = await buildApp().request('/api/invitations/pending');
    expect(res.status).toBe(401);
  });

  it('200 returns combined project + org pending invitations', async () => {
    const authToken = await signUserToken(USER_ID);
    // User lookup (select...where...limit)
    selectLimit.mockResolvedValueOnce([{ email: 'user@example.com' }]);
    // Project invitations (select...from...innerJoin...innerJoin...where)
    innerJoin2Where.mockResolvedValueOnce([
      {
        token: 'proj-token-abc',
        name: 'My Project',
        inviterEmail: 'admin@example.com',
        role: 'member',
        expiresAt: new Date(Date.now() + 86400000),
        createdAt: new Date(),
      },
    ]);
    // Org invitations (same chain, second call)
    innerJoin2Where.mockResolvedValueOnce([]);

    const res = await buildApp().request('/api/invitations/pending', {
      headers: { authorization: `Bearer ${authToken}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ kind: string; token: string; name: string }>;
    expect(body).toHaveLength(1);
    expect(body[0].kind).toBe('project');
    expect(body[0].token).toBe('proj-token-abc');
    expect(body[0].name).toBe('My Project');
  });

  it('200 returns empty array when no pending invitations', async () => {
    const authToken = await signUserToken(USER_ID);
    selectLimit.mockResolvedValueOnce([{ email: 'user@example.com' }]);
    innerJoin2Where.mockResolvedValueOnce([]);
    innerJoin2Where.mockResolvedValueOnce([]);

    const res = await buildApp().request('/api/invitations/pending', {
      headers: { authorization: `Bearer ${authToken}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as unknown[];
    expect(body).toHaveLength(0);
  });
});

describe('invitationRoutes — POST /:token/decline', () => {
  it('401 without auth', async () => {
    const res = await buildApp().request('/api/invitations/tok/decline', { method: 'POST' });
    expect(res.status).toBe(401);
  });

  it('200 dismissed:true on valid token + email match', async () => {
    const authToken = await signUserToken(USER_ID);
    selectLimit.mockResolvedValueOnce([{ email: 'user@example.com' }]);
    updateReturning.mockResolvedValueOnce([{ token: 'proj-token-abc' }]);

    const res = await buildApp().request('/api/invitations/proj-token-abc/decline', {
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

    const res = await buildApp().request('/api/invitations/not-my-token/decline', {
      method: 'POST',
      headers: { authorization: `Bearer ${authToken}` },
    });
    expect(res.status).toBe(404);
  });
});
