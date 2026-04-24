import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_SECRET = 'test-secret-at-least-32-chars-long-abcdef';

vi.mock('../config/env.js', () => ({
  env: { JWT_SECRET: TEST_SECRET, NODE_ENV: 'test' },
}));

const selectLimit = vi.fn();
const selectOffset = vi.fn(() => []);
const selectOrderBy = vi.fn(() => ({ limit: vi.fn(() => ({ offset: selectOffset })) }));
const selectWhere = vi.fn(() => ({
  limit: selectLimit,
  orderBy: selectOrderBy,
}));
const selectFrom = vi.fn(() => ({ where: selectWhere }));
const dbSelect = vi.fn(() => ({ from: selectFrom }));

vi.mock('../db/client.js', () => ({
  db: { select: dbSelect },
}));

const { searchRoutes, buildIlikePattern } = await import('./search.js');
const { signUserToken } = await import('../auth/jwt.js');
const { errorHandler } = await import('../middleware/error.js');
const { requestId } = await import('../middleware/request-id.js');

function buildApp() {
  const app = new Hono<{ Variables: import('../middleware/request-id.js').RequestIdVars }>();
  app.use('*', requestId());
  app.route('/api/projects', searchRoutes);
  app.onError(errorHandler);
  return app;
}

const USER_ID = '11111111-1111-4111-8111-111111111111';
const PROJECT_ID = '22222222-2222-4222-8222-222222222222';

beforeEach(() => {
  vi.clearAllMocks();
  selectLimit.mockReset();
});

async function token() {
  return signUserToken(USER_ID);
}

function req(qs = '', tok?: string) {
  const headers: Record<string, string> = {};
  if (tok) headers.authorization = `Bearer ${tok}`;
  return buildApp().request(`/api/projects/${PROJECT_ID}/issues/search${qs}`, {
    method: 'GET',
    headers,
  });
}

function queueProjectAccessMember() {
  // loadProjectAccess: 1) project row, 2) member row
  selectLimit.mockResolvedValueOnce([{ id: PROJECT_ID, ownerId: 'someone-else' }]);
  selectLimit.mockResolvedValueOnce([{ role: 'member' }]);
}

function queueProjectAccessNonMember() {
  selectLimit.mockResolvedValueOnce([{ id: PROJECT_ID, ownerId: 'someone-else' }]);
  selectLimit.mockResolvedValueOnce([]);
}

function queueProjectMissing() {
  selectLimit.mockResolvedValueOnce([]);
}

function queueAuthSelect() {
  // assertEmailVerified reads users table
  selectLimit.mockResolvedValueOnce([{ emailVerifiedAt: new Date() }]);
}

describe('GET /api/projects/:id/issues/search', () => {
  it('401 without token', async () => {
    const res = await req('');
    expect(res.status).toBe(401);
  });

  it('400 on invalid query param (too-long q)', async () => {
    queueAuthSelect();
    const t = await token();
    const res = await req(`?q=${'a'.repeat(201)}`, t);
    expect(res.status).toBe(400);
  });

  it('400 on unknown query key', async () => {
    queueAuthSelect();
    const t = await token();
    const res = await req('?bogus=1', t);
    expect(res.status).toBe(400);
  });

  it('400 on invalid status enum', async () => {
    queueAuthSelect();
    const t = await token();
    const res = await req('?status=not_a_status', t);
    expect(res.status).toBe(400);
  });

  it('404 when project missing', async () => {
    queueAuthSelect();
    queueProjectMissing();
    const t = await token();
    const res = await req('', t);
    expect(res.status).toBe(404);
  });

  it('403 when caller is not a member', async () => {
    queueAuthSelect();
    queueProjectAccessNonMember();
    const t = await token();
    const res = await req('', t);
    expect(res.status).toBe(403);
  });
});

describe('buildIlikePattern', () => {
  it('wraps plain text with %', () => {
    expect(buildIlikePattern('hello')).toBe('%hello%');
  });

  it('escapes % and _ characters', () => {
    expect(buildIlikePattern('100%_done')).toBe('%100\\%\\_done%');
  });

  it('escapes backslashes', () => {
    expect(buildIlikePattern('a\\b')).toBe('%a\\\\b%');
  });
});
