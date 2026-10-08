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
const listWhereArgs: unknown[] = [];
const selectWhere = vi.fn((arg?: unknown) => ({
  limit: selectLimit,
  orderBy: (...a: unknown[]) => {
    listWhereArgs.push(arg);
    return (selectOrderBy as (...x: unknown[]) => unknown)(...a);
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
vi.mock('./held-hydrator.js', () => ({
  hydrateHeldForIssues: vi.fn(async (ids: string[]) => {
    const on = (id: string) => id === '33333333-3333-4333-8333-333333333333';
    const at = '2026-09-24T18:50:58.000Z';
    return new Map(ids.map((id) => [id, { held: on(id), lastCheckInAt: on(id) ? null : at }]));
  }),
}));

// The counts and the work-state condition read the database through one module; this file asserts
// what search hands it, and `tests/integration/work-state-counts-e2e.test.ts` asserts what it counts.
const WORK_STATE_SENTINEL = { sentinel: 'the workState condition' };
const readWorkStateRows = vi.fn(
  async (
    _where?: unknown,
    _includeArchived?: boolean,
  ): Promise<Array<Record<string, unknown>>> => [],
);
const workStateCondition = vi.fn((_state: string) => WORK_STATE_SENTINEL);
vi.mock('./work-state-read.js', () => ({ readWorkStateRows, workStateCondition }));

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

function queueAuthSelect() {
  selectLimit.mockResolvedValueOnce([{ emailVerifiedAt: new Date() }]);
}

/** Whether `node` is, or holds, the column called `column` — the walk skips each column's own `table` so it ends. */
function namesColumn(node: unknown, column: string, depth = 0): boolean {
  if (depth > 8 || node === null || typeof node !== 'object') return false;
  const o = node as Record<string, unknown>;
  if (o.name === column && typeof o.table === 'object') return true;
  for (const [k, v] of Object.entries(o)) {
    if (k === 'table') continue;
    if (Array.isArray(v)) {
      for (const x of v) if (namesColumn(x, column, depth + 1)) return true;
    } else if (v && typeof v === 'object' && namesColumn(v, column, depth + 1)) {
      return true;
    }
  }
  return false;
}

/** Whether the exact object `target` appears anywhere inside `node`. */
function holds(node: unknown, target: object, depth = 0): boolean {
  if (node === target) return true;
  if (depth > 8 || node === null || typeof node !== 'object') return false;
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    if (k === 'table') continue;
    if (Array.isArray(v)) {
      for (const x of v) if (holds(x, target, depth + 1)) return true;
    } else if (v && typeof v === 'object' && holds(v, target, depth + 1)) {
      return true;
    }
  }
  return false;
}

describe('withBuckets — the strip counts (ISS-1010)', () => {
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
    expect(readWorkStateRows).not.toHaveBeenCalled();
  });

  it('withBuckets=1 → a count per status and a count per work state, and nothing else', async () => {
    queueAuthSelect();
    queueProjectAccessMember();
    queuePage();
    readWorkStateRows.mockResolvedValueOnce([
      { projectId: PROJECT_ID, status: 'closed', owesAnswer: false, n: 986 },
      { projectId: PROJECT_ID, status: 'dropped', owesAnswer: false, n: 12 },
      { projectId: PROJECT_ID, status: 'in_progress', owesAnswer: false, n: 3 },
      { projectId: PROJECT_ID, status: 'in_progress', owesAnswer: true, n: 1 },
    ]);
    const res = await req('?withBuckets=1', await token());
    expect(res.status).toBe(200);
    const b = ((await res.json()) as { buckets: Record<string, unknown> }).buckets;
    expect(Object.keys(b).sort()).toEqual(['byStatus', 'byWorkState']);
    expect(b.byStatus).toEqual({ closed: 986, dropped: 12, in_progress: 4 });
    expect(b.byWorkState).toEqual({
      open: 0,
      in_flight: 3,
      awaiting_release: 0,
      blocked_on_person: 1,
      draft: 0,
      finished: 998,
    });
  });

  it('counts the work states the status and workState filters exclude, not only the ones on screen', async () => {
    queueAuthSelect();
    queueProjectAccessMember();
    queuePage();
    listWhereArgs.length = 0;
    const res = await req('?status=needs_info&workState=in_flight&withBuckets=1', await token());
    expect(res.status).toBe(200);
    expect(workStateCondition).toHaveBeenCalledWith('in_flight');
    expect(listWhereArgs).toHaveLength(1);
    expect(namesColumn(listWhereArgs[0], 'status')).toBe(true);
    expect(holds(listWhereArgs[0], WORK_STATE_SENTINEL)).toBe(true);
    expect(readWorkStateRows).toHaveBeenCalledTimes(1);
    const bucketWhere = readWorkStateRows.mock.calls[0]?.[0];
    expect(
      namesColumn(bucketWhere, 'status'),
      'the bucket read carried the status filter — every segment but the chosen one would read zero',
    ).toBe(false);
    expect(
      holds(bucketWhere, WORK_STATE_SENTINEL),
      'the bucket read carried the work state filter — every segment but the chosen one would read zero',
    ).toBe(false);
  });

  it('narrows the counts by origin, so a strip drawn from them still adds up to its All', async () => {
    queueAuthSelect();
    queueProjectAccessMember();
    queuePage();
    const res = await req('?origin=detector&withBuckets=1', await token());
    expect(res.status).toBe(200);
    expect(readWorkStateRows).toHaveBeenCalledTimes(1);
    expect(namesColumn(readWorkStateRows.mock.calls[0]?.[0], 'detector_key')).toBe(true);
    expect(readWorkStateRows.mock.calls[0]?.[1], 'archived rows are not asked for').toBe(false);
  });
});

describe('the workState filter', () => {
  it('refuses a value outside the six by name, listing them', async () => {
    queueAuthSelect();
    queueProjectAccessMember();
    const res = await req('?workState=you', await token());
    expect(res.status).toBe(400);
    const text = JSON.stringify(await res.json());
    expect(text).toMatch(/workState/);
    for (const state of [
      'open',
      'in_flight',
      'awaiting_release',
      'blocked_on_person',
      'draft',
      'finished',
    ]) {
      expect(text).toContain(state);
    }
  });

  it('refuses the retired orWaitingOnPerson parameter by name rather than ignoring it', async () => {
    queueAuthSelect();
    queueProjectAccessMember();
    const res = await req('?status=needs_info&orWaitingOnPerson=true', await token());
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code?: string; error?: { code?: string } };
    expect(JSON.stringify(body)).toMatch(/UNKNOWN_QUERY_PARAMETER/);
    expect(JSON.stringify(body)).toMatch(/orWaitingOnPerson/);
  });
});
