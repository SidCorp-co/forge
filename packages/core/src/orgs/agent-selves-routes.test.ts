/**
 * The self and member-preference routes (ISS-1034): admin writes and reads a
 * self back, below-admin is 403, a bad presence payload is 400 with the
 * validator's own sentence, and an admin's preference write goes through the
 * one writer as `admin`.
 */
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_SECRET = 'test-secret-at-least-32-chars-long-abcdef';
vi.mock('../config/env.js', () => ({ env: { JWT_SECRET: TEST_SECRET, NODE_ENV: 'test' } }));

const orgRole = { value: 'admin' as 'admin' | 'member' };
vi.mock('../lib/authz.js', () => ({
  assertOrgAccess: async (_orgId: string, _userId: string, min: string) => {
    if (min === 'admin' && orgRole.value !== 'admin') {
      throw new HTTPException(403, { message: 'org admin required', cause: { code: 'FORBIDDEN' } });
    }
    return { orgId: _orgId, role: orgRole.value, isPersonal: false };
  },
}));

const selectLimit = vi.fn();
vi.mock('../db/client.js', () => ({
  db: {
    select: () => ({ from: () => ({ where: () => ({ limit: selectLimit }) }) }),
  },
}));

const readAgentSelf = vi.fn();
const writeAgentSelf = vi.fn();
vi.mock('./agent-selves.js', async (orig) => ({
  ...(await orig<typeof import('./agent-selves.js')>()),
  readAgentSelf: (...a: unknown[]) => readAgentSelf(...a),
  writeAgentSelf: (...a: unknown[]) => writeAgentSelf(...a),
}));
const writeAssistantPreferences = vi.fn();
vi.mock('../auth/preference-changes.js', () => ({
  writeAssistantPreferences: (...a: unknown[]) => writeAssistantPreferences(...a),
}));
vi.mock('./agent-accounts.js', () => ({
  createAgentAccount: vi.fn(),
  listAgentAccounts: vi.fn(),
  mintAgentCredential: vi.fn(),
  revokeAgentAccount: vi.fn(),
  revokeAgentCredentials: vi.fn(),
  setAgentDisplayName: vi.fn(),
  loadOrgAgent: vi.fn(),
}));

const { agentAccountRoutes } = await import('./agent-accounts-routes.js');
const { PresenceValidationError } = await import('../conversations/presence.js');
const { signUserToken } = await import('../auth/jwt.js');
const { requireAuth } = await import('../middleware/auth.js');
const { errorHandler } = await import('../middleware/error.js');
const { requestId } = await import('../middleware/request-id.js');

function buildApp() {
  const app = new Hono<{ Variables: import('../middleware/request-id.js').RequestIdVars }>();
  app.use('*', requestId());
  app.use('*', requireAuth());
  app.route('/api/orgs', agentAccountRoutes);
  app.onError(errorHandler);
  return app;
}
const ORG = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const AGENT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ADMIN = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const MEMBER = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const headers = async () => ({
  'content-type': 'application/json',
  authorization: `Bearer ${await signUserToken(ADMIN)}`,
});

beforeEach(() => {
  vi.clearAllMocks();
  orgRole.value = 'admin';
});

describe('GET/PATCH /api/orgs/:orgId/agents/:agentUserId/self', () => {
  it('an admin writes a self and reads the same values back (criterion 1)', async () => {
    const self = {
      userId: AGENT,
      soul: 'Patient.',
      instructions: null,
      emoji: '🦞',
      greeting: null,
      presence: { backoffAfter: 1 },
      updatedBy: ADMIN,
      createdAt: null,
      updatedAt: null,
    };
    writeAgentSelf.mockResolvedValueOnce(self);
    readAgentSelf.mockResolvedValueOnce(self);
    const patched = await buildApp().request(`/api/orgs/${ORG}/agents/${AGENT}/self`, {
      method: 'PATCH',
      headers: await headers(),
      body: JSON.stringify({ soul: 'Patient.', emoji: '🦞', presence: { backoffAfter: 1 } }),
    });
    expect(patched.status).toBe(200);
    expect(writeAgentSelf).toHaveBeenCalledWith(
      ORG,
      AGENT,
      { soul: 'Patient.', emoji: '🦞', presence: { backoffAfter: 1 } },
      ADMIN,
    );
    const read = await buildApp().request(`/api/orgs/${ORG}/agents/${AGENT}/self`, {
      headers: await headers(),
    });
    expect(read.status).toBe(200);
    expect(await read.json()).toEqual(JSON.parse(JSON.stringify(self)));
  });

  it('below org admin is refused 403 on both verbs (criterion 2)', async () => {
    orgRole.value = 'member';
    const read = await buildApp().request(`/api/orgs/${ORG}/agents/${AGENT}/self`, {
      headers: await headers(),
    });
    expect(read.status).toBe(403);
    const patched = await buildApp().request(`/api/orgs/${ORG}/agents/${AGENT}/self`, {
      method: 'PATCH',
      headers: await headers(),
      body: JSON.stringify({ soul: 'x' }),
    });
    expect(patched.status).toBe(403);
    expect(writeAgentSelf).not.toHaveBeenCalled();
  });

  it('404 when the id is not one of the org’s agents', async () => {
    readAgentSelf.mockResolvedValueOnce(undefined);
    const res = await buildApp().request(`/api/orgs/${ORG}/agents/${AGENT}/self`, {
      headers: await headers(),
    });
    expect(res.status).toBe(404);
  });

  it('a presence refusal is 400 carrying the validator’s own sentence (criteria 39, 40)', async () => {
    writeAgentSelf.mockRejectedValueOnce(
      new PresenceValidationError([
        'presence: unknown key(s) `chatty`; it takes only: dormantMs, backoffAfter, loopBounceMs, loopLimit, answerInGroup, heartbeat',
      ]),
    );
    const res = await buildApp().request(`/api/orgs/${ORG}/agents/${AGENT}/self`, {
      method: 'PATCH',
      headers: await headers(),
      body: JSON.stringify({ presence: { chatty: true } }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string; message: string };
    expect(body.code).toBe('PRESENCE_INVALID');
    expect(body.message).toContain('unknown key(s) `chatty`');
    expect(body.message).toContain('dormantMs, backoffAfter');
  });

  it('an empty PATCH is 400 before any write', async () => {
    const res = await buildApp().request(`/api/orgs/${ORG}/agents/${AGENT}/self`, {
      method: 'PATCH',
      headers: await headers(),
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    expect(writeAgentSelf).not.toHaveBeenCalled();
  });
});

describe('PATCH /api/orgs/:orgId/members/:userId/assistant-preferences', () => {
  it('an admin sets a member’s preferences through the one writer as admin (criterion 15)', async () => {
    selectLimit.mockResolvedValueOnce([{ userId: MEMBER }]);
    writeAssistantPreferences.mockResolvedValueOnce({
      userId: MEMBER,
      answerStyle: 'concise',
      assistantInstructions: null,
      updatedAt: null,
    });
    const res = await buildApp().request(
      `/api/orgs/${ORG}/members/${MEMBER}/assistant-preferences`,
      {
        method: 'PATCH',
        headers: await headers(),
        body: JSON.stringify({ answerStyle: 'concise' }),
      },
    );
    expect(res.status).toBe(200);
    expect(writeAssistantPreferences).toHaveBeenCalledWith({
      userId: MEMBER,
      patch: { answerStyle: 'concise' },
      actor: { kind: 'admin', userId: ADMIN },
    });
  });

  it('below org admin is refused 403 (criterion 16)', async () => {
    orgRole.value = 'member';
    const res = await buildApp().request(
      `/api/orgs/${ORG}/members/${MEMBER}/assistant-preferences`,
      {
        method: 'PATCH',
        headers: await headers(),
        body: JSON.stringify({ answerStyle: 'concise' }),
      },
    );
    expect(res.status).toBe(403);
    expect(writeAssistantPreferences).not.toHaveBeenCalled();
  });

  it('404 for a user who is not a member of the org', async () => {
    selectLimit.mockResolvedValueOnce([]);
    const res = await buildApp().request(
      `/api/orgs/${ORG}/members/${MEMBER}/assistant-preferences`,
      {
        method: 'PATCH',
        headers: await headers(),
        body: JSON.stringify({ answerStyle: 'concise' }),
      },
    );
    expect(res.status).toBe(404);
    expect(writeAssistantPreferences).not.toHaveBeenCalled();
  });
});
