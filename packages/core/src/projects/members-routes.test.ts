import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_SECRET = 'test-secret-at-least-32-chars-long-abcdef';

vi.mock('../config/env.js', () => ({
  env: {
    JWT_SECRET: TEST_SECRET,
    NODE_ENV: 'test',
    SMTP_DEBUG: true,
    APP_BASE_URL: 'http://localhost:8080',
    SMTP_HOST: 'smtp.example.com',
    SMTP_PORT: 587,
    SMTP_USER: 'u',
    SMTP_PASS: 'p',
    SMTP_FROM: 'noreply@example.com',
  },
}));

// Queue of results for sequential db.select().from().where().limit() calls.
const selectLimit = vi.fn();
const selectWhereLimit = vi.fn(() => ({ limit: selectLimit }));
// innerJoin returns a "where" step that resolves to a promise (for the members list GET).
const whereResolver = vi.fn();
const innerJoinWhere = vi.fn(() => whereResolver());
const innerJoin = vi.fn(() => ({ where: innerJoinWhere }));
const selectFrom = vi.fn(() => ({
  where: selectWhereLimit,
  innerJoin,
}));

const insertValues = vi.fn(async () => undefined);
const insert = vi.fn(() => ({ values: insertValues }));

// `where` is both awaitable (DELETE member: `await db.delete().where(...)`) and
// chainable to `.returning()` (DELETE invitation: `...where(...).returning(...)`).
const deleteReturning = vi.fn();
const deleteWhere = vi.fn(() => ({
  returning: deleteReturning,
  then: (resolve: (v: unknown) => unknown) => resolve(undefined),
}));
const deleteFn = vi.fn(() => ({ where: deleteWhere }));

const updateReturning = vi.fn();
const updateWhere = vi.fn(() => ({ returning: updateReturning }));
const updateSet = vi.fn(() => ({ where: updateWhere }));
const update = vi.fn(() => ({ set: updateSet }));

vi.mock('../db/client.js', () => ({
  db: {
    select: vi.fn(() => ({ from: selectFrom })),
    insert,
    delete: deleteFn,
    update,
    transaction: vi.fn(),
  },
}));

const sendInvitationEmail = vi.fn(async () => undefined);
vi.mock('./invitation-email.js', () => ({
  sendInvitationEmail,
}));

const issueInvitationToken = vi.fn();
vi.mock('./invitation-token.js', () => ({
  issueInvitationToken,
}));

const { memberRoutes } = await import('./members-routes.js');
const { signUserToken } = await import('../auth/jwt.js');
const { errorHandler } = await import('../middleware/error.js');
const { requestId } = await import('../middleware/request-id.js');

function buildApp() {
  const app = new Hono<{
    Variables: import('../middleware/request-id.js').RequestIdVars;
  }>();
  app.use('*', requestId());
  app.route('/api/projects', memberRoutes);
  app.onError(errorHandler);
  return app;
}

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const OWNER_ID = '22222222-2222-4222-8222-222222222222';
const OTHER_ID = '33333333-3333-4333-8333-333333333333';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('memberRoutes — POST /:projectId/members/invite', () => {
  it('401 without token', async () => {
    const res = await buildApp().request(`/api/projects/${PROJECT_ID}/members/invite`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'x@example.com', role: 'member' }),
    });
    expect(res.status).toBe(401);
  });

  it('400 BAD_REQUEST when role=owner', async () => {
    const token = await signUserToken(OWNER_ID);
    selectLimit.mockResolvedValueOnce([{ emailVerifiedAt: new Date() }]);

    const res = await buildApp().request(`/api/projects/${PROJECT_ID}/members/invite`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ email: 'x@example.com', role: 'owner' }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('BAD_REQUEST');
  });

  it('403 FORBIDDEN when caller is a regular member (not owner/admin)', async () => {
    const token = await signUserToken(OTHER_ID);
    // 1: email verified, 2: loadProjectAndCallerRole → project, 3: member role lookup
    selectLimit.mockResolvedValueOnce([{ emailVerifiedAt: new Date() }]);
    selectLimit.mockResolvedValueOnce([{ id: PROJECT_ID, name: 'p', ownerId: OWNER_ID }]);
    selectLimit.mockResolvedValueOnce([{ role: 'member' }]);

    const res = await buildApp().request(`/api/projects/${PROJECT_ID}/members/invite`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ email: 'x@example.com', role: 'member' }),
    });
    expect(res.status).toBe(403);
  });

  it('201 on happy path — owner invites a non-member; returns token in test env', async () => {
    const token = await signUserToken(OWNER_ID);
    // 1: email verified, 2: project, 3: caller member (owner), 4: inviter email, 5: existing user lookup (none)
    selectLimit.mockResolvedValueOnce([{ emailVerifiedAt: new Date() }]);
    selectLimit.mockResolvedValueOnce([{ id: PROJECT_ID, name: 'Acme', ownerId: OWNER_ID }]);
    selectLimit.mockResolvedValueOnce([{ role: 'owner' }]);
    selectLimit.mockResolvedValueOnce([{ email: 'owner@example.com' }]);
    selectLimit.mockResolvedValueOnce([]); // no existing user with that email

    const expiresAt = new Date(Date.now() + 1000);
    issueInvitationToken.mockResolvedValueOnce({ token: 'tok-xyz', expiresAt });

    const res = await buildApp().request(`/api/projects/${PROJECT_ID}/members/invite`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ email: 'new@example.com', role: 'member' }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { token: string };
    expect(body.token).toBe('tok-xyz');
    expect(issueInvitationToken).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      inviterId: OWNER_ID,
      email: 'new@example.com',
      role: 'member',
    });
    expect(sendInvitationEmail).toHaveBeenCalledTimes(1);
  });

  it('409 ALREADY_MEMBER when target user is already a project member', async () => {
    const token = await signUserToken(OWNER_ID);
    selectLimit.mockResolvedValueOnce([{ emailVerifiedAt: new Date() }]);
    selectLimit.mockResolvedValueOnce([{ id: PROJECT_ID, name: 'Acme', ownerId: OWNER_ID }]);
    selectLimit.mockResolvedValueOnce([{ role: 'owner' }]);
    selectLimit.mockResolvedValueOnce([{ email: 'owner@example.com' }]);
    selectLimit.mockResolvedValueOnce([{ id: OTHER_ID }]); // existing user
    selectLimit.mockResolvedValueOnce([{ userId: OTHER_ID }]); // already a member

    const res = await buildApp().request(`/api/projects/${PROJECT_ID}/members/invite`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ email: 'existing@example.com', role: 'member' }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('ALREADY_MEMBER');
  });
});

describe('memberRoutes — DELETE /:projectId/members/:userId', () => {
  it('409 OWNER_REMOVAL_BLOCKED when target is the project owner', async () => {
    const token = await signUserToken(OWNER_ID);
    selectLimit.mockResolvedValueOnce([{ emailVerifiedAt: new Date() }]);
    selectLimit.mockResolvedValueOnce([{ id: PROJECT_ID, name: 'p', ownerId: OWNER_ID }]);
    selectLimit.mockResolvedValueOnce([{ role: 'owner' }]);
    selectLimit.mockResolvedValueOnce([{ role: 'owner' }]); // target membership

    const res = await buildApp().request(`/api/projects/${PROJECT_ID}/members/${OWNER_ID}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('OWNER_REMOVAL_BLOCKED');
  });

  it('204 when owner removes a regular member', async () => {
    const token = await signUserToken(OWNER_ID);
    selectLimit.mockResolvedValueOnce([{ emailVerifiedAt: new Date() }]);
    selectLimit.mockResolvedValueOnce([{ id: PROJECT_ID, name: 'p', ownerId: OWNER_ID }]);
    selectLimit.mockResolvedValueOnce([{ role: 'owner' }]);
    selectLimit.mockResolvedValueOnce([{ role: 'member' }]);

    const res = await buildApp().request(`/api/projects/${PROJECT_ID}/members/${OTHER_ID}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(204);
    expect(deleteFn).toHaveBeenCalled();
  });
});

describe('memberRoutes — GET /:projectId/members/invitations', () => {
  it('200 with pending invitations (owner) — no token leaked, expired flag set', async () => {
    const token = await signUserToken(OWNER_ID);
    selectLimit.mockResolvedValueOnce([{ emailVerifiedAt: new Date() }]);
    selectLimit.mockResolvedValueOnce([{ id: PROJECT_ID, name: 'p', ownerId: OWNER_ID }]);
    selectLimit.mockResolvedValueOnce([{ role: 'owner' }]);
    const past = new Date(Date.now() - 1000);
    const future = new Date(Date.now() + 60_000);
    whereResolver.mockResolvedValueOnce([
      {
        email: 'pending@example.com',
        role: 'member',
        expiresAt: future,
        createdAt: new Date(),
        inviterEmail: 'owner@example.com',
      },
      {
        email: 'stale@example.com',
        role: 'admin',
        expiresAt: past,
        createdAt: new Date(),
        inviterEmail: 'owner@example.com',
      },
    ]);

    const res = await buildApp().request(`/api/projects/${PROJECT_ID}/members/invitations`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<Record<string, unknown>>;
    expect(body).toHaveLength(2);
    expect(body[0]).toMatchObject({ email: 'pending@example.com', expired: false });
    expect(body[1]).toMatchObject({ email: 'stale@example.com', expired: true });
    expect(body[0]).not.toHaveProperty('token');
  });

  it('403 FORBIDDEN when caller is a regular member', async () => {
    const token = await signUserToken(OTHER_ID);
    selectLimit.mockResolvedValueOnce([{ emailVerifiedAt: new Date() }]);
    selectLimit.mockResolvedValueOnce([{ id: PROJECT_ID, name: 'p', ownerId: OWNER_ID }]);
    selectLimit.mockResolvedValueOnce([{ role: 'member' }]);

    const res = await buildApp().request(`/api/projects/${PROJECT_ID}/members/invitations`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(403);
  });
});

describe('memberRoutes — DELETE /:projectId/members/invitations', () => {
  it('204 when owner revokes a pending invitation', async () => {
    const token = await signUserToken(OWNER_ID);
    selectLimit.mockResolvedValueOnce([{ emailVerifiedAt: new Date() }]);
    selectLimit.mockResolvedValueOnce([{ id: PROJECT_ID, name: 'p', ownerId: OWNER_ID }]);
    selectLimit.mockResolvedValueOnce([{ role: 'owner' }]);
    deleteReturning.mockResolvedValueOnce([{ token: 'tok-1' }]);

    const res = await buildApp().request(
      `/api/projects/${PROJECT_ID}/members/invitations?email=pending@example.com`,
      { method: 'DELETE', headers: { authorization: `Bearer ${token}` } },
    );
    expect(res.status).toBe(204);
    expect(deleteFn).toHaveBeenCalled();
  });

  it('404 INVITATION_NOT_FOUND when no pending invitation matches', async () => {
    const token = await signUserToken(OWNER_ID);
    selectLimit.mockResolvedValueOnce([{ emailVerifiedAt: new Date() }]);
    selectLimit.mockResolvedValueOnce([{ id: PROJECT_ID, name: 'p', ownerId: OWNER_ID }]);
    selectLimit.mockResolvedValueOnce([{ role: 'owner' }]);
    deleteReturning.mockResolvedValueOnce([]);

    const res = await buildApp().request(
      `/api/projects/${PROJECT_ID}/members/invitations?email=missing@example.com`,
      { method: 'DELETE', headers: { authorization: `Bearer ${token}` } },
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('INVITATION_NOT_FOUND');
  });

  it('403 FORBIDDEN when caller is a regular member', async () => {
    const token = await signUserToken(OTHER_ID);
    selectLimit.mockResolvedValueOnce([{ emailVerifiedAt: new Date() }]);
    selectLimit.mockResolvedValueOnce([{ id: PROJECT_ID, name: 'p', ownerId: OWNER_ID }]);
    selectLimit.mockResolvedValueOnce([{ role: 'member' }]);

    const res = await buildApp().request(
      `/api/projects/${PROJECT_ID}/members/invitations?email=pending@example.com`,
      { method: 'DELETE', headers: { authorization: `Bearer ${token}` } },
    );
    expect(res.status).toBe(403);
  });

  it('400 BAD_REQUEST when email query param is missing', async () => {
    const token = await signUserToken(OWNER_ID);
    selectLimit.mockResolvedValueOnce([{ emailVerifiedAt: new Date() }]);

    const res = await buildApp().request(
      `/api/projects/${PROJECT_ID}/members/invitations`,
      { method: 'DELETE', headers: { authorization: `Bearer ${token}` } },
    );
    expect(res.status).toBe(400);
  });
});
