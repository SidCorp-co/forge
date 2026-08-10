import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const RUN_ID = '22222222-2222-4222-8222-222222222222';
const USER_ID = '33333333-3333-4333-8333-333333333333';

vi.mock('../middleware/auth.js', () => ({
  requireAuth:
    () => async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
      c.set('userId', USER_ID);
      await next();
    },
  assertEmailVerified: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));
vi.mock('../lib/authz.js', () => ({
  loadProjectAccess: vi.fn(async () => ({ role: 'admin' })),
  assertProjectRole: vi.fn(),
}));
const serviceMock = vi.hoisted(() => ({
  getReconcileRun: vi.fn(),
  applyReconcileRun: vi.fn(),
  rejectReconcileRun: vi.fn(),
}));
vi.mock('./reconcile-service.js', () => ({
  getReconcileRun: serviceMock.getReconcileRun,
  applyReconcileRun: serviceMock.applyReconcileRun,
  rejectReconcileRun: serviceMock.rejectReconcileRun,
  listReconcileRunsForProject: vi.fn(),
  spawnReconcileRun: vi.fn(),
}));

const { reconcileRoutes } = await import('./reconcile-routes.js');
const { errorHandler } = await import('../middleware/error.js');
const { requestId } = await import('../middleware/request-id.js');

function buildApp() {
  const app = new Hono<{ Variables: import('../middleware/request-id.js').RequestIdVars }>();
  app.use('*', requestId());
  app.route('/api/projects', reconcileRoutes);
  app.onError(errorHandler);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  serviceMock.getReconcileRun.mockResolvedValue({ id: RUN_ID, projectId: PROJECT_ID });
});

// cm:why regression guard for ISS-808 — String(err) on an Error prepends "Error: ", which used to break the BAD_REQUEST/NOT_FOUND prefix match in reconcile-routes.ts and turned every guard rejection into a 500
describe('POST /api/projects/:projectId/reconcile-runs/:runId/reject', () => {
  it('maps a service BAD_REQUEST error to 400 with a readable message, not 500', async () => {
    serviceMock.rejectReconcileRun.mockRejectedValue(
      new Error("BAD_REQUEST: run is in terminal status 'applied', nothing to reject"),
    );
    const res = await buildApp().request(
      `/api/projects/${PROJECT_ID}/reconcile-runs/${RUN_ID}/reject`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reason: 'no longer needed' }),
      },
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { message: string; details: string };
    expect(body.details).toContain("run is in terminal status 'applied'");
  });

  it('maps a service NOT_FOUND error to 404', async () => {
    serviceMock.rejectReconcileRun.mockRejectedValue(
      new Error(`NOT_FOUND: reconcile run ${RUN_ID}`),
    );
    const res = await buildApp().request(
      `/api/projects/${PROJECT_ID}/reconcile-runs/${RUN_ID}/reject`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reason: 'no longer needed' }),
      },
    );
    expect(res.status).toBe(404);
  });

  it('returns 200 when the service resolves', async () => {
    serviceMock.rejectReconcileRun.mockResolvedValue(undefined);
    const res = await buildApp().request(
      `/api/projects/${PROJECT_ID}/reconcile-runs/${RUN_ID}/reject`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reason: 'no longer needed' }),
      },
    );
    expect(res.status).toBe(200);
  });
});

describe('POST /api/projects/:projectId/reconcile-runs/:runId/apply', () => {
  it('maps a service BAD_REQUEST error to 400, not 500', async () => {
    serviceMock.applyReconcileRun.mockRejectedValue(
      new Error("BAD_REQUEST: run is in status 'pending', expected 'decided'"),
    );
    const res = await buildApp().request(
      `/api/projects/${PROJECT_ID}/reconcile-runs/${RUN_ID}/apply`,
      {
        method: 'POST',
      },
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { message: string; details: string };
    expect(body.details).toContain("expected 'decided'");
  });
});
