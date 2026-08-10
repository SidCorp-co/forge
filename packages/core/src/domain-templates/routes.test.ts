import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_SECRET = 'test-secret-at-least-32-chars-long-abcdef';

vi.mock('../config/env.js', () => ({
  env: { JWT_SECRET: TEST_SECRET, NODE_ENV: 'test' },
}));

const selectLimit = vi.fn();
const selectOrderBy = vi.fn();
const selectWhere = vi.fn(() => ({ limit: selectLimit }));
// loadProjectAccess (lib/authz) runs select().from().leftJoin().leftJoin()
// .where().limit() — route the join chain back into the same where/limit FIFO.
const selectLeftJoin = vi.fn((): Record<string, unknown> => ({
  leftJoin: selectLeftJoin,
  where: selectWhere,
}));
const selectFrom = vi.fn(() => ({ where: selectWhere, leftJoin: selectLeftJoin, orderBy: selectOrderBy }));

vi.mock('../db/client.js', () => ({
  db: {
    select: vi.fn(() => ({ from: selectFrom })),
  },
}));

const applyTemplateMock = vi.fn();
vi.mock('./apply.js', async () => {
  const actual = await vi.importActual<typeof import('./apply.js')>('./apply.js');
  return {
    ...actual,
    applyTemplate: applyTemplateMock,
  };
});

const { domainTemplateRoutes } = await import('./routes.js');
const { signUserToken } = await import('../auth/jwt.js');
const { errorHandler } = await import('../middleware/error.js');
const { requestId } = await import('../middleware/request-id.js');
const { TemplateNotFoundError } = await import('./apply.js');

function buildApp() {
  const app = new Hono<{ Variables: import('../middleware/request-id.js').RequestIdVars }>();
  app.use('*', requestId());
  app.route('/api/domain-templates', domainTemplateRoutes);
  app.onError(errorHandler);
  return app;
}

const USER_ID = '11111111-1111-4111-8111-111111111111';
const PROJECT_ID = '33333333-3333-4333-8333-333333333333';

beforeEach(() => {
  vi.clearAllMocks();
  selectLimit.mockReset();
  selectOrderBy.mockReset();
  applyTemplateMock.mockReset();
});

function authVerified() {
  selectLimit.mockResolvedValueOnce([{ emailVerifiedAt: new Date() }]);
}

function projectAccessAsOwner() {
  selectLimit.mockResolvedValueOnce([{ orgId: 'org-1', memberRole: null, orgRole: 'owner' }]);
}

function projectAccessAsMember() {
  selectLimit.mockResolvedValueOnce([{ orgId: 'org-1', memberRole: 'member', orgRole: null }]);
}

async function token() {
  return signUserToken(USER_ID);
}

describe('GET /api/domain-templates', () => {
  it('401 without token', async () => {
    const res = await buildApp().request('/api/domain-templates');
    expect(res.status).toBe(401);
  });

  it('returns the list', async () => {
    authVerified();
    selectOrderBy.mockResolvedValueOnce([
      { id: 'x', key: 'hrm', name: 'HRM' },
      { id: 'y', key: 'ticketing', name: 'Issue Tracker' },
    ]);
    const res = await buildApp().request('/api/domain-templates', {
      headers: { authorization: `Bearer ${await token()}` },
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { length: number };
    expect(json.length).toBe(2);
  });
});

describe('GET /api/domain-templates/:key', () => {
  it('404 when missing', async () => {
    authVerified();
    selectLimit.mockResolvedValueOnce([]);
    const res = await buildApp().request('/api/domain-templates/missing', {
      headers: { authorization: `Bearer ${await token()}` },
    });
    expect(res.status).toBe(404);
  });

  it('returns the row when present', async () => {
    authVerified();
    selectLimit.mockResolvedValueOnce([{ id: 'x', key: 'hrm', name: 'HRM' }]);
    const res = await buildApp().request('/api/domain-templates/hrm', {
      headers: { authorization: `Bearer ${await token()}` },
    });
    expect(res.status).toBe(200);
  });
});

describe('POST /api/domain-templates/apply', () => {
  it('200 with apply result for owner', async () => {
    authVerified();
    projectAccessAsOwner();
    applyTemplateMock.mockResolvedValueOnce({
      templateKey: 'hrm',
      agentId: 'a-id',
      appConfigId: 'c-id',
      registeredSkillNames: [],
      skippedSkillNames: [],
    });
    const res = await buildApp().request('/api/domain-templates/apply', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${await token()}` },
      body: JSON.stringify({ projectId: PROJECT_ID, templateKey: 'hrm' }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { agentId: string };
    expect(json.agentId).toBe('a-id');
  });

  it('403 when only a regular member', async () => {
    authVerified();
    projectAccessAsMember();
    const res = await buildApp().request('/api/domain-templates/apply', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${await token()}` },
      body: JSON.stringify({ projectId: PROJECT_ID, templateKey: 'hrm' }),
    });
    expect(res.status).toBe(403);
  });

  it('404 when template missing', async () => {
    authVerified();
    projectAccessAsOwner();
    applyTemplateMock.mockRejectedValueOnce(new TemplateNotFoundError('missing'));
    const res = await buildApp().request('/api/domain-templates/apply', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${await token()}` },
      body: JSON.stringify({ projectId: PROJECT_ID, templateKey: 'missing' }),
    });
    expect(res.status).toBe(404);
  });

  it('400 on invalid payload', async () => {
    authVerified();
    const res = await buildApp().request('/api/domain-templates/apply', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${await token()}` },
      body: JSON.stringify({ projectId: 'not-a-uuid', templateKey: 'hrm' }),
    });
    expect(res.status).toBe(400);
  });
});
