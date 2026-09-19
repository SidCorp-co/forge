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

describe('POST /api/schedules — kind=sentry_pull', () => {
  function admin() {
    authVerified();
    projectAccess.mockResolvedValueOnce({
      projectId: PROJECT_ID,
      orgId: 'org-1',
      role: 'admin',
      orgRole: 'owner',
    });
  }

  async function create(body: Record<string, unknown>) {
    return buildApp().request('/api/schedules', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${await token()}` },
      body: JSON.stringify({
        projectId: PROJECT_ID,
        name: 'pull sentry',
        cron: '0 * * * *',
        ...body,
      }),
    });
  }

  it('creates one carrying no authored text at all', async () => {
    admin();
    insertReturning.mockResolvedValueOnce([{ id: 'sched-sentry-1', kind: 'sentry_pull' }]);
    const res = await create({ kind: 'sentry_pull' });
    expect(res.status).toBe(201);
    expect(insertReturning).toHaveBeenCalled();
  });

  it('400 when a prompt is supplied — it pulls what the binding declares, not what a prompt says', async () => {
    admin();
    const res = await create({ kind: 'sentry_pull', prompt: 'find the errors' });
    expect(res.status).toBe(400);
    expect(insertReturning).not.toHaveBeenCalled();
  });

  it('400 when a script is supplied', async () => {
    admin();
    const res = await create({ kind: 'sentry_pull', script: 'ctx.log("hi")' });
    expect(res.status).toBe(400);
    expect(insertReturning).not.toHaveBeenCalled();
  });

  it('400 when a templateKey is supplied', async () => {
    admin();
    const res = await create({ kind: 'sentry_pull', templateKey: 'whatever' });
    expect(res.status).toBe(400);
    expect(insertReturning).not.toHaveBeenCalled();
  });

  it('400 for a kind the schema does not declare, rather than defaulting to prompt', async () => {
    admin();
    const res = await create({ kind: 'sentry_pulll' });
    expect(res.status).toBe(400);
    expect(insertReturning).not.toHaveBeenCalled();
  });
});
