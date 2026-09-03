/**
 * ISS-903 — `GET /api/projects/:id/issues/search?withPipelineHealth=1`.
 *
 * A sibling suite rather than another block in `search.test.ts`, which is at
 * its size budget. The harness is the minimum this flag needs: auth, project
 * access, one page of issue rows, and a stubbed hydrator.
 */

import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_SECRET = 'test-secret-at-least-32-chars-long-abcdef';

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

// cm:why stubbed so this stays a serialization check — the derivation itself runs ~9 query shapes and is covered by pipeline-health*.test.ts plus tests/integration/pipeline-health-e2e.test.ts
const safeHydratePipelineHealthForIssues = vi.fn(async () => new Map());
vi.mock('./pipeline-health.js', () => ({ safeHydratePipelineHealthForIssues }));

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

beforeEach(() => {
  vi.clearAllMocks();
  selectLimit.mockReset();
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

// cm:why the board and the issues list both read THIS endpoint, so a gate reason absent here is a queued issue rendering as actively worked on both
describe('withPipelineHealth (ISS-903)', () => {
  it('omitted → response shape unchanged, no hydration runs', async () => {
    const { res, body } = await authorizedRequest('');
    expect(res.status).toBe(200);
    expect(body[0]).not.toHaveProperty('pipelineHealth');
    expect(safeHydratePipelineHealthForIssues).not.toHaveBeenCalled();
  });

  it('withPipelineHealth=1 → grafts the queued step + gate reason, ONE batched hydration', async () => {
    safeHydratePipelineHealthForIssues.mockResolvedValueOnce(
      new Map([
        [
          ISSUE_A,
          {
            stage: 'in_progress',
            queuedAt: '2026-09-03T14:43:00.000Z',
            queuedStep: {
              jobId: 'a872c0b8',
              jobType: 'drive',
              stageStatus: 'open',
              queuedAt: '2026-09-03T14:43:00.000Z',
              retryAfterAt: null,
            },
            waitingOn: { reason: 'runner_stale', since: '2026-09-03T14:43:00.000Z', details: {} },
          },
        ],
      ]),
    );
    const { res, body } = await authorizedRequest('?withPipelineHealth=1');
    expect(res.status).toBe(200);
    expect(body[0]).toMatchObject({
      id: ISSUE_A,
      pipelineHealth: {
        queuedStep: { jobId: 'a872c0b8', jobType: 'drive' },
        waitingOn: { reason: 'runner_stale' },
      },
    });
    expect(body[1]).toMatchObject({ id: ISSUE_B, pipelineHealth: { stage: 'approved' } });
    expect(safeHydratePipelineHealthForIssues).toHaveBeenCalledTimes(1);
  });

  // cm:why the wrapper's own catch is asserted in pipeline-health-queued-step.test.ts; what belongs here is the graft, not the catch
  it('grafts stage-only for every row when the hydration degrades to an empty map', async () => {
    safeHydratePipelineHealthForIssues.mockResolvedValueOnce(new Map());
    const { res, body } = await authorizedRequest('?withPipelineHealth=1');
    expect(res.status).toBe(200);
    expect(body[0]).toMatchObject({ pipelineHealth: { stage: 'in_progress' } });
    expect(body[1]).toMatchObject({ pipelineHealth: { stage: 'approved' } });
  });

  it('composes with withAgentSessions=1 (both surfaces read one call)', async () => {
    safeHydratePipelineHealthForIssues.mockResolvedValueOnce(
      new Map([[ISSUE_A, { stage: 'in_progress' }]]),
    );
    const { res, body } = await authorizedRequest('?withPipelineHealth=1&withAgentSessions=1');
    expect(res.status).toBe(200);
    expect(body[0]).toMatchObject({
      id: ISSUE_A,
      agentStatus: 'running',
      pipelineHealth: { stage: 'in_progress' },
    });
  });
});
