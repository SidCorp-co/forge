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
  // The totalCount query awaits select().from().where() directly — make the
  // chain object thenable so the 200-path tests (ISS-437) can run through it.
  then: (resolve: (v: unknown) => void) => resolve([{ n: 0 }]),
}));
// loadProjectAccess (lib/authz) runs select().from().leftJoin().leftJoin()
// .where().limit() — route the join chain back into the same where/limit FIFO.
const selectLeftJoin = vi.fn((): Record<string, unknown> => ({
  leftJoin: selectLeftJoin,
  where: selectWhere,
}));
// ISS-437 — the withCost rollup runs select().from(subquery).innerJoin()
// .groupBy() (awaited directly; mockReturnValueOnce an array of
// `{ issueId, estimatedCost }` rows).
const costGroupBy = vi.fn(() => []);
const selectInnerJoin = vi.fn(() => ({ groupBy: costGroupBy }));
const selectFrom = vi.fn(() => ({
  where: selectWhere,
  leftJoin: selectLeftJoin,
  innerJoin: selectInnerJoin,
}));
const dbSelect = vi.fn(() => ({ from: selectFrom }));
// ISS-437 — the rollup's DISTINCT (issue, session) subquery is only BUILT
// (never awaited): selectDistinct().from().where().as('…') must return a
// column-bag the outer query can reference.
const distinctAs = vi.fn(() => ({ issueId: 'issue_sessions.issue_id', sessionId: 'issue_sessions.session_id' }));
const dbSelectDistinct = vi.fn(() => ({
  from: vi.fn(() => ({ where: vi.fn(() => ({ as: distinctAs })) })),
}));

vi.mock('../db/client.js', () => ({
  db: { select: dbSelect, selectDistinct: dbSelectDistinct },
}));

// ISS-437 — the agent-session hydrator hits the db with its own query shapes;
// stub it so the withCost ∘ withAgentSessions composition test stays a pure
// serialization check.
vi.mock('./agent-sessions-hydrator.js', () => ({
  hydrateAgentSessionsForIssues: vi.fn(async () => new Map([
    ['33333333-3333-4333-8333-333333333333', { agentSessions: [], agentStatus: 'running' }],
  ])),
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
  selectLimit.mockResolvedValueOnce([{ orgId: 'org-1', memberRole: 'member', orgRole: null }]);
}

function queueProjectAccessNonMember() {
  selectLimit.mockResolvedValueOnce([{ orgId: 'org-1', memberRole: null, orgRole: null }]);
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

  it('400 on invalid sort value', async () => {
    queueAuthSelect();
    const t = await token();
    const res = await req('?sort=bogus', t);
    expect(res.status).toBe(400);
  });

  // ISS-236 — statusNot mirrors the status enum and supports array form so the
  // web list page can hide drafts by default while a Draft chip can still
  // include them on demand.
  it('400 on invalid statusNot enum', async () => {
    queueAuthSelect();
    const t = await token();
    const res = await req('?statusNot=not_a_status', t);
    expect(res.status).toBe(400);
  });

  it('400 when category exceeds 100 chars', async () => {
    queueAuthSelect();
    const t = await token();
    const res = await req(`?category=${'a'.repeat(101)}`, t);
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

// ISS-437 — opt-in per-issue cost rollup on the search response.
describe('withCost (ISS-437)', () => {
  const ISSUE_A = '33333333-3333-4333-8333-333333333333';
  const ISSUE_B = '44444444-4444-4444-8444-444444444444';

  function queueIssuesPage() {
    selectOffset.mockReturnValueOnce([
      { id: ISSUE_A, issSeq: 1, title: 'a' },
      { id: ISSUE_B, issSeq: 2, title: 'b' },
    ]);
  }

  it('omitted → response shape unchanged, no rollup query runs', async () => {
    queueAuthSelect();
    queueProjectAccessMember();
    queueIssuesPage();
    const t = await token();
    const res = await req('', t);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(2);
    expect(body[0]).toMatchObject({ id: ISSUE_A, displayId: 'ISS-1' });
    expect(body[0]).not.toHaveProperty('estimatedCost');
    expect(dbSelectDistinct).not.toHaveBeenCalled();
  });

  it('withCost=1 → one grouped rollup; issues without usage report 0', async () => {
    queueAuthSelect();
    queueProjectAccessMember();
    queueIssuesPage();
    costGroupBy.mockReturnValueOnce([{ issueId: ISSUE_A, estimatedCost: 1.23 }]);
    const t = await token();
    const res = await req('?withCost=1', t);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body[0]).toMatchObject({ id: ISSUE_A, displayId: 'ISS-1', estimatedCost: 1.23 });
    expect(body[1]).toMatchObject({ id: ISSUE_B, estimatedCost: 0 });
    // Exactly ONE extra query regardless of page size (the grouped rollup).
    // The DISTINCT-session fan-out semantics live in the SQL itself (same
    // shape as the cost-summary route) — covered by integration, not mocks.
    expect(dbSelectDistinct).toHaveBeenCalledTimes(1);
    expect(selectInnerJoin).toHaveBeenCalledTimes(1);
  });

  it('composes with withAgentSessions=1 (cost + agent fields on the same row)', async () => {
    queueAuthSelect();
    queueProjectAccessMember();
    queueIssuesPage();
    costGroupBy.mockReturnValueOnce([{ issueId: ISSUE_A, estimatedCost: 0.5 }]);
    const t = await token();
    const res = await req('?withCost=1&withAgentSessions=1', t);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body[0]).toMatchObject({ id: ISSUE_A, estimatedCost: 0.5, agentStatus: 'running' });
    expect(body[1]).toMatchObject({ id: ISSUE_B, estimatedCost: 0, agentStatus: null });
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
