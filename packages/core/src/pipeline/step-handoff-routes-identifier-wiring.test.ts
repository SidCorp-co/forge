/**
 * ISS-1160 — `GET /api/issue-step-contexts` is the eighth route the second
 * judging pass found this defect spans, and the only one of the eight that
 * already carried a required `?projectId=` before this issue: it needed only
 * its `issueId` query param widened, and the resolved-uuid handed to
 * `resolveIssueKeyInProject` (Layer A — the caller here already owns its
 * project scope, asserted via `assertProjectAccess` before this call).
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
}));

const assertProjectAccess = vi.fn(async (..._args: unknown[]) => undefined);
vi.mock('../lib/authz.js', () => ({
  assertProjectAccess: (...a: unknown[]) => assertProjectAccess(...a),
}));

const resolveIssueKeyInProject = vi.fn((..._args: unknown[]) => Promise.resolve(''));
vi.mock('../issues/issue-route-ref.js', () => ({
  resolveIssueKeyInProject: (...a: unknown[]) => resolveIssueKeyInProject(...a),
}));

const getIssueContexts = vi.fn(async (..._args: unknown[]) => [] as unknown[]);
vi.mock('./issue-context-store.js', () => ({
  getIssueContexts: (...a: unknown[]) => getIssueContexts(...a),
  writeIssueContext: vi.fn(),
  deleteIssueContext: vi.fn(),
}));

const { stepHandoffRoutes } = await import('./step-handoff-routes.js');
const { errorHandler } = await import('../middleware/error.js');
const { requestId } = await import('../middleware/request-id.js');

function buildApp() {
  const app = new Hono<{ Variables: import('../middleware/request-id.js').RequestIdVars }>();
  app.use('*', requestId());
  app.route('/api/issue-step-contexts', stepHandoffRoutes);
  app.onError(errorHandler);
  return app;
}

const ISSUE_ID = '11111111-1111-4111-8111-111111111111';
const PROJECT_ID = '22222222-2222-4222-8222-222222222222';

beforeEach(() => {
  vi.clearAllMocks();
  getIssueContexts.mockResolvedValue([]);
  assertProjectAccess.mockResolvedValue(undefined);
});

describe('GET /api/issue-step-contexts — the display key this issue reported (ISS-1160)', () => {
  it('a display key resolves inside the already-asserted ?projectId=, uuid handed to getIssueContexts', async () => {
    resolveIssueKeyInProject.mockResolvedValueOnce(ISSUE_ID);
    const res = await buildApp().request(
      `/api/issue-step-contexts?projectId=${PROJECT_ID}&issueId=ISS-1185`,
    );
    expect(res.status).toBe(200);
    expect(assertProjectAccess).toHaveBeenCalledWith(PROJECT_ID, undefined, 'viewer');
    expect(resolveIssueKeyInProject).toHaveBeenCalledWith('ISS-1185', PROJECT_ID);
    expect(getIssueContexts).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: PROJECT_ID, issueId: ISSUE_ID }),
    );
  });

  it('a uuid issueId still passes straight through', async () => {
    resolveIssueKeyInProject.mockResolvedValueOnce(ISSUE_ID);
    const res = await buildApp().request(
      `/api/issue-step-contexts?projectId=${PROJECT_ID}&issueId=${ISSUE_ID}`,
    );
    expect(res.status).toBe(200);
    expect(resolveIssueKeyInProject).toHaveBeenCalledWith(ISSUE_ID, PROJECT_ID);
  });

  it('surfaces the resolver refusal — a key naming nothing in this project', async () => {
    resolveIssueKeyInProject.mockRejectedValueOnce(
      new HTTPException(404, {
        message: '`ISS-1185` names no issue in this project',
        cause: { code: 'NOT_FOUND' },
      }),
    );
    const res = await buildApp().request(
      `/api/issue-step-contexts?projectId=${PROJECT_ID}&issueId=ISS-1185`,
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { message: string };
    expect(body.message).toMatch(/ISS-1185/);
  });
});
