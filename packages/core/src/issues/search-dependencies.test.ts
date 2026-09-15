/**
 * ISS-1017 — `GET /api/projects/:id/issues/search?withDependencies=1`.
 *
 * A sibling suite rather than another block in `search.test.ts`, which is at
 * its size budget, and modelled on `search-pipeline-health.test.ts`. The
 * batched loader is stubbed: how it groups and scopes its one query is
 * `dependency-read-batch.test.ts`, and what belongs here is the opt-in, the
 * graft, and the key a row gets when it has no edges.
 */

import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_SECRET = 'test-secret-at-least-32-chars-long-abcdef';

// cm:why the prefix reader is a collaborator with a query shape of its own, stubbed so this file stays a check of what the module under test does with the reference rather than of how the prefix is read (ISS-992)
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
const selectWhere = vi.fn(() => ({
  limit: selectLimit,
  orderBy: selectOrderBy,
  then: (resolve: (v: unknown) => void) => resolve([{ n: 0 }]),
}));
const selectLeftJoin = vi.fn(
  (): Record<string, unknown> => ({ leftJoin: selectLeftJoin, where: selectWhere }),
);
const selectFrom = vi.fn(() => ({ where: selectWhere, leftJoin: selectLeftJoin }));
const dbSelect = vi.fn(() => ({ from: selectFrom }));

vi.mock('../db/client.js', () => ({ db: { select: dbSelect } }));

const loadIssueDependencyEdgesForIssues = vi.fn(
  async (): Promise<Map<string, unknown>> => new Map(),
);
vi.mock('./dependency-read.js', () => ({ loadIssueDependencyEdgesForIssues }));

vi.mock('./agent-sessions-hydrator.js', () => ({
  hydrateAgentSessionsForIssues: vi.fn(
    async () =>
      new Map([
        ['33333333-3333-4333-8333-333333333333', { agentSessions: [], agentStatus: 'running' }],
      ]),
  ),
}));

vi.mock('./creator.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./creator.js')>();
  return { ...actual, hydrateCreatorsForIssues: vi.fn(async () => new Map()) };
});

const { searchRoutes } = await import('./search.js');
const { signUserToken } = await import('../auth/jwt.js');
const { errorHandler } = await import('../middleware/error.js');
const { requestId } = await import('../middleware/request-id.js');

const USER_ID = '11111111-1111-4111-8111-111111111111';
const PROJECT_ID = '22222222-2222-4222-8222-222222222222';
const ISSUE_A = '33333333-3333-4333-8333-333333333333';
const ISSUE_B = '44444444-4444-4444-8444-444444444444';

const EDGE = {
  id: '55555555-5555-4555-8555-555555555555',
  projectId: PROJECT_ID,
  fromIssueId: ISSUE_A,
  toIssueId: ISSUE_B,
  kind: 'blocks',
  reason: null,
  createdById: null,
  createdAt: '2026-09-01T00:00:00.000Z',
  validUntil: null,
  fromTitle: 'a',
  fromStatus: 'in_progress',
  fromMergedAt: null,
  toTitle: 'b',
  toStatus: 'approved',
  toMergedAt: null,
  fromDisplayId: 'FD-1',
  toDisplayId: 'FX-7',
};

beforeEach(() => {
  vi.clearAllMocks();
  selectLimit.mockReset();
  loadIssueDependencyEdgesForIssues.mockResolvedValue(new Map());
});

async function authorizedRequest(qs: string) {
  // cm:guard three queued rows in THIS order — assertEmailVerified reads users, then loadProjectAccess reads the project row and the member row; they share one FIFO, so a missing entry answers 401/404 rather than the case under test
  selectLimit.mockResolvedValueOnce([{ emailVerifiedAt: new Date() }]);
  selectLimit.mockResolvedValueOnce([{ orgId: 'org-1', memberRole: 'member', orgRole: null }]);
  selectOffset.mockReturnValueOnce([
    { id: ISSUE_A, issSeq: 1, title: 'a', status: 'in_progress' },
    { id: ISSUE_B, issSeq: 2, title: 'b', status: 'approved' },
  ]);
  const app = new Hono<{ Variables: import('../middleware/request-id.js').RequestIdVars }>();
  app.use('*', requestId());
  app.route('/api/projects', searchRoutes);
  app.onError(errorHandler);
  const res = await app.request(`/api/projects/${PROJECT_ID}/issues/search${qs}`, {
    method: 'GET',
    headers: { authorization: `Bearer ${await signUserToken(USER_ID)}` },
  });
  const body = res.ok ? ((await res.json()) as { items: Record<string, unknown>[] }).items : [];
  return { res, body };
}

// cm:why this flag is what the issues list renders its badges from, so a row missing the key is a row whose chips come from whatever the cache still holds
describe('withDependencies (ISS-1017)', () => {
  it('omitted → no dependencies key, and the read does not run', async () => {
    const { res, body } = await authorizedRequest('');
    expect(res.status).toBe(200);
    expect(body[0]).not.toHaveProperty('dependencies');
    expect(loadIssueDependencyEdgesForIssues).not.toHaveBeenCalled();
  });

  it('withDependencies=1 → grafts both directions, in ONE batched read over the page', async () => {
    loadIssueDependencyEdgesForIssues.mockResolvedValueOnce(
      new Map<string, unknown>([
        [ISSUE_A, { outgoing: [EDGE], incoming: [] }],
        [ISSUE_B, { outgoing: [], incoming: [EDGE] }],
      ]),
    );
    const { res, body } = await authorizedRequest('?withDependencies=1');
    expect(res.status).toBe(200);
    expect(body[0]).toMatchObject({
      id: ISSUE_A,
      dependencies: { outgoing: [EDGE], incoming: [] },
    });
    expect(body[1]).toMatchObject({
      id: ISSUE_B,
      dependencies: { outgoing: [], incoming: [EDGE] },
    });
    expect(loadIssueDependencyEdgesForIssues).toHaveBeenCalledTimes(1);
    expect(loadIssueDependencyEdgesForIssues).toHaveBeenCalledWith([ISSUE_A, ISSUE_B], PROJECT_ID);
  });

  // cm:guard the ISS-437 rule: a row with no edges carries both arrays, never a missing key, so a client cannot read "not hydrated" as "no relations"
  it('a row the read omits still carries both arrays', async () => {
    loadIssueDependencyEdgesForIssues.mockResolvedValueOnce(
      new Map<string, unknown>([[ISSUE_A, { outgoing: [EDGE], incoming: [] }]]),
    );
    const { body } = await authorizedRequest('?withDependencies=1');
    expect(body[1]).toMatchObject({ id: ISSUE_B, dependencies: { outgoing: [], incoming: [] } });
  });

  it('preserves the enriched edge shape the single-issue read returns', async () => {
    loadIssueDependencyEdgesForIssues.mockResolvedValueOnce(
      new Map<string, unknown>([[ISSUE_A, { outgoing: [EDGE], incoming: [] }]]),
    );
    const { body } = await authorizedRequest('?withDependencies=1');
    const [edge] = (body[0] as { dependencies: { outgoing: Record<string, unknown>[] } })
      .dependencies.outgoing;
    expect(edge).toEqual(EDGE);
  });

  it('composes with withAgentSessions=1, which returns through a second envelope', async () => {
    loadIssueDependencyEdgesForIssues.mockResolvedValueOnce(
      new Map<string, unknown>([[ISSUE_A, { outgoing: [EDGE], incoming: [] }]]),
    );
    const { res, body } = await authorizedRequest('?withDependencies=1&withAgentSessions=1');
    expect(res.status).toBe(200);
    expect(body[0]).toMatchObject({
      id: ISSUE_A,
      agentStatus: 'running',
      dependencies: { outgoing: [EDGE] },
    });
  });

  // cm:why the route's schema is `.strict()`, and this endpoint refusing an unknown parameter by name is the contract its sibling list route was made to match (ISS-991)
  it('refuses a misspelled flag by name rather than ignoring it', async () => {
    const { res } = await authorizedRequest('?withDependency=1');
    expect(res.status).toBe(400);
    expect(loadIssueDependencyEdgesForIssues).not.toHaveBeenCalled();
  });
});
