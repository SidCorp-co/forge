import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_SECRET = 'test-secret-at-least-32-chars-long-abcdef';

vi.mock('../config/env.js', () => ({
  env: { JWT_SECRET: TEST_SECRET, NODE_ENV: 'test' },
}));

const selectLimit = vi.fn();
const selectOrderBy = vi.fn();
const selectWhere = vi.fn(() => ({ limit: selectLimit, orderBy: selectOrderBy }));
const selectFrom = vi.fn(() => ({ where: selectWhere }));
const insertReturning = vi.fn();
const insertValues = vi.fn(() => ({ returning: insertReturning }));
const updateReturning = vi.fn();
const updateWhere = vi.fn(() => ({ returning: updateReturning }));
const updateSet = vi.fn(() => ({ where: updateWhere }));
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
vi.mock('../lib/project-access.js', () => ({
  loadProjectAccess: (...args: unknown[]) => projectAccess(...args),
}));

vi.mock('../jobs/enqueue.js', () => ({
  enqueueJob: vi.fn(async () => undefined),
}));

// ISS-101 — stub run lifecycle helpers so schedule.run insert tests keep
// using their existing single-insert mock plumbing.
vi.mock('../pipeline/runs.js', () => ({
  openIssueRun: vi.fn(async () => ({ id: 'run-1', startedAt: new Date() })),
  openOneShotRun: vi.fn(async () => ({ id: 'run-1' })),
  closeRun: vi.fn(async () => undefined),
  closeRunIfOneShot: vi.fn(async () => undefined),
  closeOpenRunForIssue: vi.fn(async () => undefined),
  setCurrentStep: vi.fn(async () => undefined),
  setCurrentStepForOpenIssueRun: vi.fn(async () => undefined),
}));

const { scheduleRoutes } = await import('./routes.js');
const { signUserToken } = await import('../auth/jwt.js');
const { errorHandler } = await import('../middleware/error.js');
const { requestId } = await import('../middleware/request-id.js');
const hooksModule = await import('../pipeline/hooks.js');

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
const JOB_ID = '44444444-4444-4444-8444-444444444444';

beforeEach(() => {
  vi.clearAllMocks();
  selectLimit.mockReset();
  selectOrderBy.mockReset();
  insertReturning.mockReset();
  updateReturning.mockReset();
  deleteWhere.mockReset();
  projectAccess.mockReset();
  hooksModule.hooks.reset();
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
    projectAccess.mockResolvedValueOnce({ projectId: PROJECT_ID, ownerId: USER_ID, role: 'owner' });
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
    projectAccess.mockResolvedValueOnce({ projectId: PROJECT_ID, ownerId: USER_ID, role: 'owner' });
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

  it('403 non-owner', async () => {
    authVerified();
    projectAccess.mockResolvedValueOnce({ projectId: PROJECT_ID, ownerId: 'x', role: 'member' });
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

  it('201 inserts schedule with nextRunAt', async () => {
    authVerified();
    projectAccess.mockResolvedValueOnce({ projectId: PROJECT_ID, ownerId: USER_ID, role: 'owner' });
    insertReturning.mockResolvedValueOnce([
      {
        id: SCHEDULE_ID,
        projectId: PROJECT_ID,
        name: 'daily',
        cron: '0 9 * * *',
        prompt: 'p',
        runner: 'antigravity',
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
    const body = (await res.json()) as { id: string; nextRunAt: string };
    expect(body.id).toBe(SCHEDULE_ID);
    expect(body.nextRunAt).toBeDefined();
    const insertCall = insertValues.mock.calls[0]?.[0] as { nextRunAt?: Date | null };
    expect(insertCall?.nextRunAt).toBeInstanceOf(Date);
  });
});

describe('GET /api/schedules', () => {
  it('lists schedules for project', async () => {
    authVerified();
    projectAccess.mockResolvedValueOnce({ projectId: PROJECT_ID, ownerId: USER_ID, role: 'member' });
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

  it('202 enqueues job + emits scheduleRun', async () => {
    authVerified();
    selectLimit.mockResolvedValueOnce([
      {
        id: SCHEDULE_ID,
        projectId: PROJECT_ID,
        name: 'daily',
        cron: '0 9 * * *',
        prompt: 'p',
        runner: 'antigravity',
        targetProjectSlug: null,
      },
    ]);
    projectAccess.mockResolvedValueOnce({ projectId: PROJECT_ID, ownerId: USER_ID, role: 'member' });
    insertReturning.mockResolvedValueOnce([{ id: JOB_ID }]);

    let emitted: unknown = null;
    hooksModule.hooks.on('scheduleRun', (p) => {
      emitted = p;
    });

    const res = await buildApp().request(`/api/schedules/${SCHEDULE_ID}/run`, {
      method: 'POST',
      headers: { authorization: `Bearer ${await token()}` },
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { sessionId: string };
    expect(body.sessionId).toBe(JOB_ID);
    expect(emitted).toMatchObject({ scheduleId: SCHEDULE_ID, jobId: JOB_ID });
  });

  it('202 cross-project: resolves targetProjectSlug + dispatches against target', async () => {
    authVerified();
    // 1. select schedule
    selectLimit.mockResolvedValueOnce([
      {
        id: SCHEDULE_ID,
        projectId: PROJECT_ID,
        prompt: 'p',
        runner: 'antigravity',
        targetProjectSlug: 'marketing',
      },
    ]);
    // 2. source-project access
    projectAccess.mockResolvedValueOnce({ projectId: PROJECT_ID, ownerId: USER_ID, role: 'owner' });
    // 3. assertTargetProjectAccess: project lookup by slug
    selectLimit.mockResolvedValueOnce([{ id: TARGET_PROJECT_ID }]);
    // 4. assertTargetProjectAccess: target-project access
    projectAccess.mockResolvedValueOnce({
      projectId: TARGET_PROJECT_ID,
      ownerId: 'someone-else',
      role: 'member',
    });
    // Dispatcher reuses the route's `resolvedTarget`, so no second slug lookup.
    insertReturning.mockResolvedValueOnce([{ id: JOB_ID }]);

    let emitted: { projectId?: string } | null = null;
    hooksModule.hooks.on('scheduleRun', (p) => {
      emitted = p as { projectId: string };
    });

    const res = await buildApp().request(`/api/schedules/${SCHEDULE_ID}/run`, {
      method: 'POST',
      headers: { authorization: `Bearer ${await token()}` },
    });
    expect(res.status).toBe(202);
    expect(emitted).not.toBeNull();
    expect(emitted!.projectId).toBe(TARGET_PROJECT_ID);
    const insertCall = insertValues.mock.calls[0]?.[0] as { projectId?: string };
    expect(insertCall?.projectId).toBe(TARGET_PROJECT_ID);
  });

  it('400 when targetProjectSlug points to a non-existent project', async () => {
    authVerified();
    selectLimit.mockResolvedValueOnce([
      {
        id: SCHEDULE_ID,
        projectId: PROJECT_ID,
        prompt: 'p',
        runner: 'antigravity',
        targetProjectSlug: 'nope',
      },
    ]);
    projectAccess.mockResolvedValueOnce({ projectId: PROJECT_ID, ownerId: USER_ID, role: 'owner' });
    // assertTargetProjectAccess: slug lookup → empty
    selectLimit.mockResolvedValueOnce([]);

    const res = await buildApp().request(`/api/schedules/${SCHEDULE_ID}/run`, {
      method: 'POST',
      headers: { authorization: `Bearer ${await token()}` },
    });
    expect(res.status).toBe(400);
    expect(insertReturning).not.toHaveBeenCalled();
  });

  it('403 when actor is not a member of the target project', async () => {
    authVerified();
    selectLimit.mockResolvedValueOnce([
      {
        id: SCHEDULE_ID,
        projectId: PROJECT_ID,
        prompt: 'p',
        runner: 'antigravity',
        targetProjectSlug: 'marketing',
      },
    ]);
    projectAccess.mockResolvedValueOnce({ projectId: PROJECT_ID, ownerId: USER_ID, role: 'owner' });
    // assertTargetProjectAccess: slug lookup → found
    selectLimit.mockResolvedValueOnce([{ id: TARGET_PROJECT_ID }]);
    // target-project access: not a member, not the owner
    projectAccess.mockResolvedValueOnce({
      projectId: TARGET_PROJECT_ID,
      ownerId: 'someone-else',
      role: null,
    });

    const res = await buildApp().request(`/api/schedules/${SCHEDULE_ID}/run`, {
      method: 'POST',
      headers: { authorization: `Bearer ${await token()}` },
    });
    expect(res.status).toBe(403);
    expect(insertReturning).not.toHaveBeenCalled();
  });
});

describe('POST /api/schedules — targetProjectSlug auth gate', () => {
  const TARGET_PROJECT_ID = '66666666-6666-4666-8666-666666666666';

  it('403 when actor is not a member of the target project', async () => {
    authVerified();
    projectAccess.mockResolvedValueOnce({ projectId: PROJECT_ID, ownerId: USER_ID, role: 'owner' });
    // assertTargetProjectAccess: slug → found
    selectLimit.mockResolvedValueOnce([{ id: TARGET_PROJECT_ID }]);
    projectAccess.mockResolvedValueOnce({
      projectId: TARGET_PROJECT_ID,
      ownerId: 'someone-else',
      role: null,
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
    projectAccess.mockResolvedValueOnce({ projectId: PROJECT_ID, ownerId: USER_ID, role: 'owner' });
    // assertTargetProjectAccess: slug → not found
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
