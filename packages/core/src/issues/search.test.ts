import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_SECRET = 'test-secret-at-least-32-chars-long-abcdef';

vi.mock('./issue-prefix-read.js', () => ({
  activeIssuePrefix: async () => null,
  heldIssuePrefixes: async () => [],
}));
vi.mock('../config/env.js', () => ({
  env: { JWT_SECRET: TEST_SECRET, NODE_ENV: 'test' },
}));

const selectLimit = vi.fn();
const selectOffset = vi.fn((): Record<string, unknown>[] => []);
const selectOrderBy = vi.fn(() => ({ limit: vi.fn(() => ({ offset: selectOffset })) }));
const bucketGroupBy = vi.fn((): Record<string, unknown>[] => []);
const bucketWhereArgs: unknown[] = [];
const listWhereArgs: unknown[] = [];
const selectWhere = vi.fn((arg?: unknown) => ({
  limit: selectLimit,
  orderBy: (...a: unknown[]) => {
    listWhereArgs.push(arg);
    return (selectOrderBy as (...x: unknown[]) => unknown)(...a);
  },
  groupBy: (...a: unknown[]) => {
    bucketWhereArgs.push(arg);
    return (bucketGroupBy as (...x: unknown[]) => unknown)(...a);
  },
  then: (resolve: (v: unknown) => void) => resolve([{ n: 0 }]),
}));
const selectLeftJoin = vi.fn(
  (): Record<string, unknown> => ({
    leftJoin: selectLeftJoin,
    where: selectWhere,
  }),
);
// ISS-437 — the withCost rollup runs select().from(subquery).innerJoin()
// .groupBy() (awaited directly; mockReturnValueOnce an array of
// `{ issueId, estimatedCost }` rows).
const costGroupBy = vi.fn((): Record<string, unknown>[] => []);
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
const distinctAs = vi.fn(() => ({
  issueId: 'issue_sessions.issue_id',
  sessionId: 'issue_sessions.session_id',
}));
const dbSelectDistinct = vi.fn(() => ({
  from: vi.fn(() => ({ where: vi.fn(() => ({ as: distinctAs })) })),
}));
const failureInfoOrderBy = vi.fn((): Record<string, unknown>[] => []);
const dbSelectDistinctOn = vi.fn(() => ({
  from: vi.fn(() => ({ where: vi.fn(() => ({ orderBy: failureInfoOrderBy })) })),
}));

vi.mock('../db/client.js', () => ({
  db: { select: dbSelect, selectDistinct: dbSelectDistinct, selectDistinctOn: dbSelectDistinctOn },
}));

// ISS-437 — the agent-session hydrator hits the db with its own query shapes;
// stub it so the withCost ∘ withAgentSessions composition test stays a pure
// serialization check.
vi.mock('./agent-sessions-hydrator.js', () => ({
  hydrateAgentSessionsForIssues: vi.fn(
    async () =>
      new Map([
        ['33333333-3333-4333-8333-333333333333', { agentSessions: [], agentStatus: 'running' }],
      ]),
  ),
}));

const hydrateCreatorsForIssues = vi.fn(async () => new Map());
vi.mock('./creator.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./creator.js')>();
  return { ...actual, hydrateCreatorsForIssues };
});

const { searchRoutes } = await import('./search.js');
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
    const body = ((await res.json()) as { items: Record<string, unknown>[] }).items;
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
    const body = ((await res.json()) as { items: Record<string, unknown>[] }).items;
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
    const body = ((await res.json()) as { items: Record<string, unknown>[] }).items;
    expect(body[0]).toMatchObject({ id: ISSUE_A, estimatedCost: 0.5, agentStatus: 'running' });
    expect(body[1]).toMatchObject({ id: ISSUE_B, estimatedCost: 0, agentStatus: null });
  });
});

// ISS-700 — opt-in latest-failed-job info on the search response, backing the
// issues-list row's Failed-badge tooltip.
describe('withFailureInfo (ISS-700)', () => {
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
    const body = ((await res.json()) as { items: Record<string, unknown>[] }).items;
    expect(body[0]).not.toHaveProperty('failureInfo');
    expect(dbSelectDistinctOn).not.toHaveBeenCalled();
  });

  it('withFailureInfo=1 → attaches the latest failed job; issues with none get null', async () => {
    queueAuthSelect();
    queueProjectAccessMember();
    queueIssuesPage();
    const finishedAt = new Date('2026-07-01T00:00:00.000Z');
    failureInfoOrderBy.mockReturnValueOnce([
      {
        issueId: ISSUE_A,
        failedStep: 'code',
        failureReason: 'build failed',
        failureKind: 'code',
        finishedAt,
      },
    ]);
    const t = await token();
    const res = await req('?withFailureInfo=1', t);
    expect(res.status).toBe(200);
    const body = ((await res.json()) as { items: Record<string, unknown>[] }).items;
    expect(body[0]).toMatchObject({
      id: ISSUE_A,
      failureInfo: {
        failedStep: 'code',
        failureReason: 'build failed',
        failureKind: 'code',
        failedAt: finishedAt.toISOString(),
      },
    });
    expect(body[1]).toMatchObject({ id: ISSUE_B, failureInfo: null });
    expect(dbSelectDistinctOn).toHaveBeenCalledTimes(1);
  });

  it('composes with withCost=1 (both fields on the same row)', async () => {
    queueAuthSelect();
    queueProjectAccessMember();
    queueIssuesPage();
    costGroupBy.mockReturnValueOnce([{ issueId: ISSUE_A, estimatedCost: 0.5 }]);
    failureInfoOrderBy.mockReturnValueOnce([
      {
        issueId: ISSUE_B,
        failedStep: 'review',
        failureReason: null,
        failureKind: 'infra',
        finishedAt: null,
      },
    ]);
    const t = await token();
    const res = await req('?withCost=1&withFailureInfo=1', t);
    expect(res.status).toBe(200);
    const body = ((await res.json()) as { items: Record<string, unknown>[] }).items;
    expect(body[0]).toMatchObject({ id: ISSUE_A, estimatedCost: 0.5, failureInfo: null });
    expect(body[1]).toMatchObject({
      id: ISSUE_B,
      estimatedCost: 0,
      failureInfo: {
        failedStep: 'review',
        failureReason: null,
        failedAt: new Date(0).toISOString(),
      },
    });
  });
});

describe('createdBy filter + creator hydration (ISS-756)', () => {
  const ISSUE_A = '33333333-3333-4333-8333-333333333333';
  const ISSUE_B = '44444444-4444-4444-8444-444444444444';
  const PERSON_ID = '55555555-5555-4555-8555-555555555555';

  function queueIssuesPage() {
    selectOffset.mockReturnValueOnce([
      { id: ISSUE_A, issSeq: 1, title: 'a', createdById: PERSON_ID, createdVia: 'web' },
      { id: ISSUE_B, issSeq: 2, title: 'b', createdById: PERSON_ID, createdVia: 'mcp' },
    ]);
  }

  it('400 on a createdBy value that is neither a uuid nor "agent"', async () => {
    queueAuthSelect();
    const t = await token();
    const res = await req('?createdBy=not-a-uuid-or-agent', t);
    expect(res.status).toBe(400);
  });

  it('200 accepts createdBy=agent', async () => {
    queueAuthSelect();
    queueProjectAccessMember();
    queueIssuesPage();
    const t = await token();
    const res = await req('?createdBy=agent', t);
    expect(res.status).toBe(200);
  });

  it('200 accepts a person uuid', async () => {
    queueAuthSelect();
    queueProjectAccessMember();
    queueIssuesPage();
    const t = await token();
    const res = await req(`?createdBy=${PERSON_ID}`, t);
    expect(res.status).toBe(200);
  });

  it('hydrates creatorEmail/creatorIsAgent/creatorLabel on every row unconditionally', async () => {
    queueAuthSelect();
    queueProjectAccessMember();
    queueIssuesPage();
    hydrateCreatorsForIssues.mockResolvedValueOnce(
      new Map([
        [
          ISSUE_A,
          {
            creatorEmail: 'owner@example.com',
            creatorIsAgent: false,
            creatorLabel: 'owner@example.com',
          },
        ],
        [
          ISSUE_B,
          { creatorEmail: 'master@agents.local', creatorIsAgent: true, creatorLabel: 'master' },
        ],
      ]),
    );
    const t = await token();
    const res = await req('', t);
    expect(res.status).toBe(200);
    const body = ((await res.json()) as { items: Record<string, unknown>[] }).items;
    expect(body[0]).toMatchObject({
      id: ISSUE_A,
      creatorLabel: 'owner@example.com',
      creatorIsAgent: false,
    });
    expect(body[1]).toMatchObject({
      id: ISSUE_B,
      creatorLabel: 'master',
      creatorIsAgent: true,
    });
    expect(hydrateCreatorsForIssues).toHaveBeenCalledTimes(1);
  });
});

function namesStatusColumn(node: unknown, depth = 0): boolean {
  if (depth > 8 || node === null || typeof node !== 'object') return false;
  const o = node as Record<string, unknown>;
  if (o.name === 'status' && typeof o.table === 'object') return true;
  for (const [k, v] of Object.entries(o)) {
    if (k === 'table') continue;
    if (Array.isArray(v)) {
      for (const x of v) if (namesStatusColumn(x, depth + 1)) return true;
    } else if (v && typeof v === 'object' && namesStatusColumn(v, depth + 1)) {
      return true;
    }
  }
  return false;
}

describe('withBuckets — the tab counts (ISS-1010)', () => {
  function queuePage() {
    selectOffset.mockReturnValueOnce([{ id: 'x', issSeq: 1, title: 'a' }]);
  }

  it('omitted → no buckets on the envelope and no grouped read', async () => {
    queueAuthSelect();
    queueProjectAccessMember();
    queuePage();
    const res = await req('', await token());
    expect(res.status).toBe(200);
    expect(await res.json()).not.toHaveProperty('buckets');
    expect(bucketGroupBy).not.toHaveBeenCalled();
  });

  it('withBuckets=1 → per-status counts plus the two origin counts', async () => {
    queueAuthSelect();
    queueProjectAccessMember();
    queuePage();
    bucketGroupBy.mockReturnValueOnce([
      { status: 'closed', n: 986 },
      { status: 'dropped', n: 12 },
    ]);
    const res = await req('?withBuckets=1', await token());
    expect(res.status).toBe(200);
    const b = ((await res.json()) as { buckets: Record<string, unknown> }).buckets;
    expect(b.byStatus).toMatchObject({ closed: 986, dropped: 12 });
    expect(b).toHaveProperty('detector');
    expect(b).toHaveProperty('humanDraft');
  });

  it('counts the statuses the status filter excludes, not only the ones on screen', async () => {
    queueAuthSelect();
    queueProjectAccessMember();
    queuePage();
    bucketGroupBy.mockReturnValueOnce([{ status: 'closed', n: 986 }]);
    bucketWhereArgs.length = 0;
    listWhereArgs.length = 0;
    const res = await req('?status=needs_info&withBuckets=1', await token());
    expect(res.status).toBe(200);
    expect(bucketWhereArgs).toHaveLength(1);
    expect(listWhereArgs).toHaveLength(1);
    expect(namesStatusColumn(listWhereArgs[0])).toBe(true);
    expect(
      namesStatusColumn(bucketWhereArgs[0]),
      'the bucket read carried the status filter — every tab but the open one would read zero',
    ).toBe(false);
  });
});
