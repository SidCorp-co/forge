import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_SECRET = 'test-secret-at-least-32-chars-long-abcdef';

vi.mock('../config/env.js', () => ({
  env: { JWT_SECRET: TEST_SECRET, NODE_ENV: 'test' },
}));

// Typed `(_payload: unknown)` parameters keep `mock.calls[i]` as `[unknown]`
// for strict tsconfig — see ISS-244 dispatch.test.ts for the same pattern.
const selectLimit = vi.fn();
const selectOrderBy = vi.fn();
const selectWhere = vi.fn((_p: unknown) => ({ limit: selectLimit, orderBy: selectOrderBy }));
const selectFrom = vi.fn((_p: unknown) => ({ where: selectWhere }));
const insertReturning = vi.fn();
const insertValues = vi.fn((_payload: unknown) => ({ returning: insertReturning }));
const updateReturning = vi.fn();
const updateWhere = vi.fn((_p: unknown) => ({ returning: updateReturning }));
const updateSet = vi.fn((_payload: unknown) => ({ where: updateWhere }));
const deleteWhere = vi.fn();

vi.mock('../db/client.js', () => ({
  db: {
    select: vi.fn(() => ({ from: selectFrom })),
    insert: vi.fn(() => ({ values: insertValues })),
    update: vi.fn(() => ({ set: updateSet })),
    delete: vi.fn(() => ({ where: deleteWhere })),
  },
}));

const projectAccess = vi.fn();
vi.mock('../lib/authz.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/authz.js')>()),
  loadProjectAccess: (...args: unknown[]) => projectAccess(...args),
}));

// ISS-244 — route tests exercise only the route layer. The dispatcher itself
// has dedicated coverage in `dispatch.test.ts`, so we mock it here to keep
// these tests focused on auth + request/response shape + lastStatus writes.
const dispatchMock = vi.fn();
vi.mock('./dispatch.js', () => ({
  dispatchScheduleRun: (...args: unknown[]) => dispatchMock(...args),
}));

const { scheduleRoutes } = await import('./routes.js');
const { signUserToken } = await import('../auth/jwt.js');
const { errorHandler } = await import('../middleware/error.js');
const { requestId } = await import('../middleware/request-id.js');

function buildApp() {
  const app = new Hono<{ Variables: import('../middleware/request-id.js').RequestIdVars }>();
  app.use('*', requestId());
  app.route('/api/schedules', scheduleRoutes);
  app.onError(errorHandler);
  return app;
}

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const SCHEDULE_ID = '33333333-3333-4333-8333-333333333333';
const SESSION_ID = '44444444-4444-4444-8444-444444444444';

beforeEach(() => {
  vi.clearAllMocks();
  selectLimit.mockReset();
  selectOrderBy.mockReset();
  insertReturning.mockReset();
  updateReturning.mockReset();
  deleteWhere.mockReset();
  projectAccess.mockReset();
  dispatchMock.mockReset();
});

function authVerified() {
  selectLimit.mockResolvedValueOnce([{ emailVerifiedAt: new Date() }]);
}

async function token() {
  return signUserToken(USER_ID);
}

describe('POST /api/schedules', () => {
  it('400 invalid cron', async () => {
    authVerified();
    projectAccess.mockResolvedValueOnce({ projectId: PROJECT_ID, orgId: 'org-1', role: 'admin', orgRole: 'owner' });
    const res = await buildApp().request('/api/schedules', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${await token()}` },
      body: JSON.stringify({
        projectId: PROJECT_ID,
        name: 'daily',
        cron: 'not-a-cron',
        prompt: 'do thing',
      }),
    });
    expect(res.status).toBe(400);
  });

  it('400 cron under 1 hour', async () => {
    authVerified();
    projectAccess.mockResolvedValueOnce({ projectId: PROJECT_ID, orgId: 'org-1', role: 'admin', orgRole: 'owner' });
    const res = await buildApp().request('/api/schedules', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${await token()}` },
      body: JSON.stringify({
        projectId: PROJECT_ID,
        name: 'every-min',
        cron: '* * * * *',
        prompt: 'do thing',
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { message?: string };
    expect(body.message).toMatch(/1 hour/);
  });

  it('400 runner:antigravity rejected (ISS-244 — desktop-only on interactive path)', async () => {
    authVerified();
    projectAccess.mockResolvedValueOnce({ projectId: PROJECT_ID, orgId: 'org-1', role: 'admin', orgRole: 'owner' });
    const res = await buildApp().request('/api/schedules', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${await token()}` },
      body: JSON.stringify({
        projectId: PROJECT_ID,
        name: 'daily',
        cron: '0 9 * * *',
        prompt: 'p',
        runner: 'antigravity',
      }),
    });
    expect(res.status).toBe(400);
    expect(insertReturning).not.toHaveBeenCalled();
  });

  it('403 non-owner', async () => {
    authVerified();
    projectAccess.mockResolvedValueOnce({ projectId: PROJECT_ID, orgId: 'org-1', role: 'member', orgRole: null });
    const res = await buildApp().request('/api/schedules', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${await token()}` },
      body: JSON.stringify({
        projectId: PROJECT_ID,
        name: 'daily',
        cron: '0 9 * * *',
        prompt: 'do thing',
      }),
    });
    expect(res.status).toBe(403);
  });

  it('201 inserts schedule with desktop runner default + nextRunAt', async () => {
    authVerified();
    projectAccess.mockResolvedValueOnce({ projectId: PROJECT_ID, orgId: 'org-1', role: 'admin', orgRole: 'owner' });
    insertReturning.mockResolvedValueOnce([
      {
        id: SCHEDULE_ID,
        projectId: PROJECT_ID,
        name: 'daily',
        cron: '0 9 * * *',
        prompt: 'p',
        runner: 'desktop',
        enabled: true,
        nextRunAt: new Date('2026-04-26T09:00:00Z'),
      },
    ]);

    const res = await buildApp().request('/api/schedules', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${await token()}` },
      body: JSON.stringify({
        projectId: PROJECT_ID,
        name: 'daily',
        cron: '0 9 * * *',
        prompt: 'p',
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; nextRunAt: string; runner: string };
    expect(body.id).toBe(SCHEDULE_ID);
    expect(body.nextRunAt).toBeDefined();
    const insertCall = insertValues.mock.calls[0]?.[0] as unknown as { nextRunAt?: Date | null; runner?: string };
    expect(insertCall?.nextRunAt).toBeInstanceOf(Date);
    expect(insertCall?.runner).toBe('desktop');
  });
});

describe('PUT /api/schedules/:id', () => {
  it('400 runner:antigravity rejected on update (ISS-244)', async () => {
    authVerified();
    selectLimit.mockResolvedValueOnce([
      { id: SCHEDULE_ID, projectId: PROJECT_ID, cron: '0 9 * * *', enabled: true },
    ]);
    projectAccess.mockResolvedValueOnce({ projectId: PROJECT_ID, orgId: 'org-1', role: 'admin', orgRole: 'owner' });
    const res = await buildApp().request(`/api/schedules/${SCHEDULE_ID}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${await token()}` },
      body: JSON.stringify({ runner: 'antigravity' }),
    });
    expect(res.status).toBe(400);
    expect(updateReturning).not.toHaveBeenCalled();
  });
});

describe('GET /api/schedules', () => {
  it('lists schedules for project', async () => {
    authVerified();
    projectAccess.mockResolvedValueOnce({ projectId: PROJECT_ID, orgId: 'org-1', role: 'member', orgRole: null });
    selectOrderBy.mockResolvedValueOnce([
      { id: SCHEDULE_ID, projectId: PROJECT_ID, name: 'daily' },
    ]);

    const res = await buildApp().request(`/api/schedules?projectId=${PROJECT_ID}`, {
      headers: { authorization: `Bearer ${await token()}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ id: string }>;
    expect(body[0]?.id).toBe(SCHEDULE_ID);
  });

  it('400 missing projectId', async () => {
    authVerified();
    const res = await buildApp().request('/api/schedules', {
      headers: { authorization: `Bearer ${await token()}` },
    });
    expect(res.status).toBe(400);
  });
});

describe('POST /api/schedules/:id/run', () => {
  const TARGET_PROJECT_ID = '55555555-5555-4555-8555-555555555555';

  it('202 dispatches and returns { sessionId } (no jobId alias)', async () => {
    authVerified();
    selectLimit.mockResolvedValueOnce([
      {
        id: SCHEDULE_ID,
        projectId: PROJECT_ID,
        name: 'daily',
        cron: '0 9 * * *',
        prompt: 'p',
        runner: 'desktop',
        targetProjectSlug: null,
      },
    ]);
    projectAccess.mockResolvedValueOnce({ projectId: PROJECT_ID, orgId: 'org-1', role: 'member', orgRole: null });
    dispatchMock.mockResolvedValueOnce({
      ok: true,
      sessionId: SESSION_ID,
      status: 'success',
      resolvedProjectId: PROJECT_ID,
    });

    const res = await buildApp().request(`/api/schedules/${SCHEDULE_ID}/run`, {
      method: 'POST',
      headers: { authorization: `Bearer ${await token()}` },
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { sessionId: string; jobId?: string };
    expect(body.sessionId).toBe(SESSION_ID);
    expect(body.jobId).toBeUndefined();
    // lastStatus written from dispatch result
    const statusWrites = updateSet.mock.calls.map((c) => c[0] as { lastStatus?: string });
    expect(statusWrites.some((p) => p?.lastStatus === 'success')).toBe(true);
  });

  it('409 no-device → SCHEDULE_DISPATCH_FAILED', async () => {
    authVerified();
    selectLimit.mockResolvedValueOnce([
      {
        id: SCHEDULE_ID,
        projectId: PROJECT_ID,
        prompt: 'p',
        runner: 'desktop',
        targetProjectSlug: null,
      },
    ]);
    projectAccess.mockResolvedValueOnce({ projectId: PROJECT_ID, orgId: 'org-1', role: 'member', orgRole: null });
    dispatchMock.mockResolvedValueOnce({
      ok: false,
      reason: 'no-device',
      status: 'skipped',
    });

    const res = await buildApp().request(`/api/schedules/${SCHEDULE_ID}/run`, {
      method: 'POST',
      headers: { authorization: `Bearer ${await token()}` },
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { message?: string };
    expect(body.message).toBe('no-device');
  });

  it('202 cross-project: resolves targetProjectSlug + passes resolvedTarget to dispatch', async () => {
    authVerified();
    selectLimit.mockResolvedValueOnce([
      {
        id: SCHEDULE_ID,
        projectId: PROJECT_ID,
        prompt: 'p',
        runner: 'desktop',
        targetProjectSlug: 'marketing',
      },
    ]);
    projectAccess.mockResolvedValueOnce({ projectId: PROJECT_ID, orgId: 'org-1', role: 'admin', orgRole: 'owner' });
    selectLimit.mockResolvedValueOnce([{ id: TARGET_PROJECT_ID }]);
    projectAccess.mockResolvedValueOnce({
      projectId: TARGET_PROJECT_ID,
      orgId: 'org-1',
      role: 'member',
      orgRole: null,
    });
    dispatchMock.mockResolvedValueOnce({
      ok: true,
      sessionId: SESSION_ID,
      status: 'success',
      resolvedProjectId: TARGET_PROJECT_ID,
    });

    const res = await buildApp().request(`/api/schedules/${SCHEDULE_ID}/run`, {
      method: 'POST',
      headers: { authorization: `Bearer ${await token()}` },
    });
    expect(res.status).toBe(202);
    const dispatchArg = dispatchMock.mock.calls[0]?.[0] as unknown as {
      resolvedTarget?: { id: string };
    };
    expect(dispatchArg?.resolvedTarget?.id).toBe(TARGET_PROJECT_ID);
  });

  it('400 when targetProjectSlug points to a non-existent project', async () => {
    authVerified();
    selectLimit.mockResolvedValueOnce([
      {
        id: SCHEDULE_ID,
        projectId: PROJECT_ID,
        prompt: 'p',
        runner: 'desktop',
        targetProjectSlug: 'nope',
      },
    ]);
    projectAccess.mockResolvedValueOnce({ projectId: PROJECT_ID, orgId: 'org-1', role: 'admin', orgRole: 'owner' });
    selectLimit.mockResolvedValueOnce([]);

    const res = await buildApp().request(`/api/schedules/${SCHEDULE_ID}/run`, {
      method: 'POST',
      headers: { authorization: `Bearer ${await token()}` },
    });
    expect(res.status).toBe(400);
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it('403 when actor is not a member of the target project', async () => {
    authVerified();
    selectLimit.mockResolvedValueOnce([
      {
        id: SCHEDULE_ID,
        projectId: PROJECT_ID,
        prompt: 'p',
        runner: 'desktop',
        targetProjectSlug: 'marketing',
      },
    ]);
    projectAccess.mockResolvedValueOnce({ projectId: PROJECT_ID, orgId: 'org-1', role: 'admin', orgRole: 'owner' });
    selectLimit.mockResolvedValueOnce([{ id: TARGET_PROJECT_ID }]);
    projectAccess.mockResolvedValueOnce({
      projectId: TARGET_PROJECT_ID,
      orgId: 'org-1',
      role: null,
      orgRole: null,
    });

    const res = await buildApp().request(`/api/schedules/${SCHEDULE_ID}/run`, {
      method: 'POST',
      headers: { authorization: `Bearer ${await token()}` },
    });
    expect(res.status).toBe(403);
    expect(dispatchMock).not.toHaveBeenCalled();
  });
});

describe('POST /api/schedules — targetProjectSlug auth gate', () => {
  const TARGET_PROJECT_ID = '66666666-6666-4666-8666-666666666666';

  it('403 when actor is not a member of the target project', async () => {
    authVerified();
    projectAccess.mockResolvedValueOnce({ projectId: PROJECT_ID, orgId: 'org-1', role: 'admin', orgRole: 'owner' });
    selectLimit.mockResolvedValueOnce([{ id: TARGET_PROJECT_ID }]);
    projectAccess.mockResolvedValueOnce({
      projectId: TARGET_PROJECT_ID,
      orgId: 'org-1',
      role: null,
      orgRole: null,
    });

    const res = await buildApp().request('/api/schedules', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${await token()}` },
      body: JSON.stringify({
        projectId: PROJECT_ID,
        name: 'daily',
        cron: '0 9 * * *',
        prompt: 'p',
        targetProjectSlug: 'marketing',
      }),
    });
    expect(res.status).toBe(403);
    expect(insertReturning).not.toHaveBeenCalled();
  });

  it('400 when targetProjectSlug points to a non-existent project', async () => {
    authVerified();
    projectAccess.mockResolvedValueOnce({ projectId: PROJECT_ID, orgId: 'org-1', role: 'admin', orgRole: 'owner' });
    selectLimit.mockResolvedValueOnce([]);

    const res = await buildApp().request('/api/schedules', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${await token()}` },
      body: JSON.stringify({
        projectId: PROJECT_ID,
        name: 'daily',
        cron: '0 9 * * *',
        prompt: 'p',
        targetProjectSlug: 'nope',
      }),
    });
    expect(res.status).toBe(400);
    expect(insertReturning).not.toHaveBeenCalled();
  });
});

describe('cron validation', () => {
  it('accepts hourly cron', async () => {
    const { validateCron } = await import('./cron.js');
    expect(validateCron('0 * * * *').ok).toBe(true);
  });

  it('rejects every-minute cron', async () => {
    const { validateCron } = await import('./cron.js');
    expect(validateCron('* * * * *').ok).toBe(false);
  });

  it('rejects garbage', async () => {
    const { validateCron } = await import('./cron.js');
    expect(validateCron('garbage').ok).toBe(false);
  });
});
