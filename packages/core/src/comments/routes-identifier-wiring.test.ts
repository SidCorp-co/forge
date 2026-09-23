/**
 * ISS-1160 — `GET /api/issues/:id/comments` is one of the eight routes the second
 * judging pass found this defect spans. This file proves the WIRING: the route
 * parses `:id` as any non-empty string, reads `?projectId=`, hands both to the
 * shared `resolveIssueRouteRef`, and returns what it resolves — or surfaces its
 * refusal verbatim. The resolver's own resolution logic is
 * `../issues/issue-route-ref.test.ts`'s; this file does not re-derive it.
 */

import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../config/env.js', () => ({
  env: { JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef', NODE_ENV: 'test' },
}));

vi.mock('../middleware/auth.js', () => ({
  requireAuth: () => async (_c: unknown, next: () => Promise<void>) => next(),
  assertEmailVerified: () => async (_c: unknown, next: () => Promise<void>) => next(),
  restActor: () => ({ agency: 'human' }),
  restAuthored: (v: unknown) => v,
}));

vi.mock('../db/client.js', () => ({
  db: { select: () => ({ from: () => ({ where: async () => [{ n: 0 }] }) }) },
}));

const resolveIssueRouteRef = vi.fn();
vi.mock('../issues/issue-route-ref.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../issues/issue-route-ref.js')>()),
  resolveIssueRouteRef: (...a: unknown[]) => resolveIssueRouteRef(...a),
}));

vi.mock('./service.js', () => ({
  listIssueCommentPage: async () => ({ rows: [], nextCursor: null }),
}));
vi.mock('./tree.js', () => ({
  buildCommentTree: () => [],
  attachAuthors: () => undefined,
}));
vi.mock('../messaging/record-screen.js', () => ({
  projectLens: async () => ({}),
}));
vi.mock('../issues/actor-resolution.js', () => ({
  resolveActors: async () => new Map(),
}));

const { issueRoutes } = await import('../issues/routes.js');
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

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/issues/:id/comments — forwards to the shared resolver (ISS-1160)', () => {
  it('a uuid path segment reaches the resolver with no projectId', async () => {
    resolveIssueRouteRef.mockResolvedValueOnce({ id: ISSUE_ID, projectId: PROJECT_ID });
    const res = await buildApp().request(`/api/issues/${ISSUE_ID}/comments`);
    expect(res.status).toBe(200);
    expect(resolveIssueRouteRef).toHaveBeenCalledWith(ISSUE_ID, undefined, undefined);
  });

  it('a display key with ?projectId= reaches the resolver with both, unmangled', async () => {
    resolveIssueRouteRef.mockResolvedValueOnce({ id: ISSUE_ID, projectId: PROJECT_ID });
    const res = await buildApp().request(`/api/issues/ISS-1185/comments?projectId=${PROJECT_ID}`);
    expect(res.status).toBe(200);
    expect(resolveIssueRouteRef).toHaveBeenCalledWith('ISS-1185', PROJECT_ID, undefined);
  });

  it('surfaces the resolver refusal verbatim — a key with no project to scope it', async () => {
    resolveIssueRouteRef.mockRejectedValueOnce(
      new HTTPException(400, {
        message: 'Invalid input',
        cause: { code: 'BAD_REQUEST', details: { formErrors: ['needs ?projectId='] } },
      }),
    );
    const res = await buildApp().request('/api/issues/ISS-1185/comments');
    expect(res.status).toBe(400);
    const body = (await res.json()) as { details?: { formErrors?: string[] } };
    expect(body.details?.formErrors?.join(' ')).toMatch(/projectId=/);
  });
});
