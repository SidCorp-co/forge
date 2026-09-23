// ISS-1160: `GET /api/issues/:id` is the literal reported reproduction. This file
// proves the route forwards `:id`/`?projectId=` to `resolveIssueRouteRef` and
// surfaces its result or refusal verbatim; the resolver's own logic is
// `issue-route-ref.test.ts`'s.

import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_SECRET = 'test-secret-at-least-32-chars-long-abcdef';
vi.mock('../config/env.js', () => ({
  env: { JWT_SECRET: TEST_SECRET, NODE_ENV: 'test' },
}));

// This file's claim is the ROUTE'S wiring to the shared resolver, not auth —
// bypass it the way `dependency-routes.test.ts` does, so `c.get('userId')` is
// simply undefined and every case below can assert on it plainly.
vi.mock('../middleware/auth.js', () => ({
  requireAuth: () => async (_c: unknown, next: () => Promise<void>) => next(),
  assertEmailVerified: () => async (_c: unknown, next: () => Promise<void>) => next(),
  restActor: () => ({ agency: 'human' }),
  restAuthored: (v: unknown) => v,
}));

// Nothing on the exercised path calls the real database — every module that
// would touch it (`resolveIssueRouteRef`, the hydration helpers) is replaced
// below. This stub only keeps the real `db/client.js` (and the postgres pool
// it opens at import) out of a unit test's way.
vi.mock('../db/client.js', () => ({ db: {} }));

const resolveIssueRouteRef = vi.fn();
vi.mock('./issue-route-ref.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./issue-route-ref.js')>()),
  resolveIssueRouteRef: (...a: unknown[]) => resolveIssueRouteRef(...a),
}));

vi.mock('./label-service.js', () => ({
  listIssueLabels: async () => [],
}));
vi.mock('./pipeline-health.js', () => ({
  safeHydratePipelineHealthForIssues: async () => new Map(),
}));
vi.mock('./agent-sessions-hydrator.js', () => ({
  hydrateAgentSessionsForIssues: async () => new Map(),
}));
vi.mock('./creator.js', () => ({
  hydrateCreatorsForIssues: async () => new Map(),
}));
vi.mock('./issue-prefix-read.js', () => ({
  activeIssuePrefix: async () => null,
  heldIssuePrefixes: async () => [],
}));

const { issueRoutes } = await import('./routes.js');
const { errorHandler } = await import('../middleware/error.js');
const { requestId } = await import('../middleware/request-id.js');

function buildApp() {
  const app = new Hono<{ Variables: import('../middleware/request-id.js').RequestIdVars }>();
  app.use('*', requestId());
  app.route('/api/issues', issueRoutes);
  app.onError(errorHandler);
  return app;
}

const ISSUE_ID = '11111111-1111-4111-8111-111111111111';
const PROJECT_ID = '22222222-2222-4222-8222-222222222222';

const RESOLVED_ROW = {
  id: ISSUE_ID,
  projectId: PROJECT_ID,
  issSeq: 1185,
  description: null,
  descriptionFormat: 'markdown',
  mergedAt: null,
  mergedCommitSha: null,
  createdById: null,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/issues/:id — forwards to the shared resolver (ISS-1160)', () => {
  it('a uuid path segment reaches the resolver with no projectId, and its row is served', async () => {
    resolveIssueRouteRef.mockResolvedValueOnce(RESOLVED_ROW);
    const res = await buildApp().request(`/api/issues/${ISSUE_ID}`);
    expect(res.status).toBe(200);
    expect(resolveIssueRouteRef).toHaveBeenCalledWith(ISSUE_ID, undefined, undefined);
  });

  it('a display key with ?projectId= reaches the resolver with both, unmangled', async () => {
    resolveIssueRouteRef.mockResolvedValueOnce(RESOLVED_ROW);
    const res = await buildApp().request(`/api/issues/ISS-1185?projectId=${PROJECT_ID}`);
    expect(res.status).toBe(200);
    expect(resolveIssueRouteRef).toHaveBeenCalledWith('ISS-1185', PROJECT_ID, undefined);
  });

  it('surfaces the resolver refusal verbatim rather than reinterpreting it', async () => {
    resolveIssueRouteRef.mockRejectedValueOnce(
      new HTTPException(400, {
        message: 'Invalid input',
        cause: { code: 'BAD_REQUEST', details: { formErrors: ['needs ?projectId='] } },
      }),
    );
    const res = await buildApp().request('/api/issues/ISS-1185');
    expect(res.status).toBe(400);
    const body = (await res.json()) as { details?: { formErrors?: string[] } };
    expect(body.details?.formErrors?.join(' ')).toMatch(/projectId=/);
  });

  it('a malformed :id is NOT rejected at the param-schema layer any more — it reaches the resolver', async () => {
    resolveIssueRouteRef.mockRejectedValueOnce(
      new HTTPException(400, { message: 'Invalid input' }),
    );
    const res = await buildApp().request('/api/issues/not-an-issue');
    expect(res.status).toBe(400);
    expect(resolveIssueRouteRef).toHaveBeenCalledWith('not-an-issue', undefined, undefined);
  });
});
