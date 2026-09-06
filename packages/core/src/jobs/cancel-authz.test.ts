/**
 * ISS-653 — who may cancel a job, and nothing else about cancelling one.
 *
 * The Operator Ops Console's A2 reap button posts to `POST /api/jobs/:id/cancel`
 * for a stuck job in ANY tenant, and the platform admin who runs that console is
 * a member of nothing. `cancelJob` and `resumeHeldJob` are stubbed here so the
 * suite is exactly the route's authz fork: `lifecycle-routes.test.ts` owns what
 * happens once the caller is through it.
 */

import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_SECRET = 'test-secret-at-least-32-chars-long-abcdef-123456';
const ADMIN_EMAIL = 'ops@example.com';
const VALID_JOB_ID = '11111111-1111-4111-8111-111111111111';

const testEnv: { JWT_SECRET: string; NODE_ENV: string; ADMIN_EMAILS?: string | undefined } = {
  JWT_SECRET: TEST_SECRET,
  NODE_ENV: 'test',
};
vi.mock('../config/env.js', () => ({ env: testEnv }));

const selectLimit = vi.fn();
const selectWhere = vi.fn(() => ({ limit: selectLimit }));
vi.mock('../db/client.js', () => ({
  db: { select: () => ({ from: () => ({ where: selectWhere }) }) },
}));

const projectRole: { role: string | null } = { role: 'admin' };
vi.mock('../lib/authz.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/authz.js')>()),
  loadProjectAccess: async () => ({
    projectId: 'p1',
    orgId: 'org-1',
    role: projectRole.role,
    orgRole: projectRole.role === null ? null : 'owner',
  }),
}));

const cancelJobMock = vi.fn(async () => ({ id: 'j1', status: 'cancelled' }));
vi.mock('./cancel-job.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./cancel-job.js')>()),
  cancelJob: (...args: unknown[]) => cancelJobMock(...(args as [])),
}));

const resumeJobMock = vi.fn(async () => ({ id: 'j1', status: 'queued' }));
vi.mock('./resume-job.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./resume-job.js')>()),
  resumeHeldJob: (...args: unknown[]) => resumeJobMock(...(args as [])),
}));

vi.mock('./dispatch-tick.js', () => ({ dispatchTickForProject: async () => {} }));

const { jobLifecycleUserRoutes } = await import('./lifecycle-routes.js');
const { errorHandler } = await import('../middleware/error.js');
const { requestId } = await import('../middleware/request-id.js');
const { signUserToken } = await import('../auth/jwt.js');

const verifiedUser = { id: 'u-1', emailVerifiedAt: new Date() };
const job = { id: 'j1', projectId: 'p1', status: 'running', deviceId: 'dev-1' };

beforeEach(() => {
  vi.clearAllMocks();
  selectLimit.mockReset();
  projectRole.role = 'admin';
  testEnv.ADMIN_EMAILS = undefined;
});

// cm:guard the allow-list read is a THIRD `selectLimit` call, after assertEmailVerified and the route's own loadJob — queue only two and `assertPlatformAdmin` reads the JOB row as a user, which answers 401 instead of the 403 the test is about
function queueLoads(...rows: unknown[]): void {
  selectLimit.mockResolvedValueOnce([verifiedUser]);
  for (const row of rows) selectLimit.mockResolvedValueOnce([row]);
}

async function post(verb: 'cancel' | 'resume'): Promise<Response> {
  const app = new Hono<{ Variables: import('../middleware/request-id.js').RequestIdVars }>();
  app.use('*', requestId());
  app.route('/api/jobs', jobLifecycleUserRoutes);
  app.onError(errorHandler);
  return app.fetch(
    new Request(`http://localhost/api/jobs/${VALID_JOB_ID}/${verb}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${await signUserToken('u-1')}` },
    }),
  );
}

describe('POST /:id/cancel — who is allowed through', () => {
  it('lets a project member through without reading the allow-list', async () => {
    projectRole.role = 'member';
    queueLoads(job);

    expect((await post('cancel')).status).toBe(200);
    expect(cancelJobMock).toHaveBeenCalled();
  });

  it('lets a non-member on ADMIN_EMAILS through, matching the address case-insensitively', async () => {
    projectRole.role = null;
    testEnv.ADMIN_EMAILS = `someone-else@example.com, ${ADMIN_EMAIL}`;
    queueLoads(job, { email: ADMIN_EMAIL.toUpperCase() });

    expect((await post('cancel')).status).toBe(200);
    expect(cancelJobMock).toHaveBeenCalled();
  });

  it('refuses a non-member who is not on the allow-list', async () => {
    projectRole.role = null;
    testEnv.ADMIN_EMAILS = ADMIN_EMAIL;
    queueLoads(job, { email: 'outsider@example.com' });

    const r = await post('cancel');
    expect(r.status).toBe(403);
    expect((await r.json()) as { code?: string }).toMatchObject({ code: 'ADMIN_ONLY' });
    expect(cancelJobMock).not.toHaveBeenCalled();
  });

  // cm:guard an unset ADMIN_EMAILS parses to the EMPTY allow-list, which must admit nobody — a `!raw` early return that fell through to "allow" would open every tenant's jobs to every signed-in user on any deploy that never set the var
  it('refuses everyone when ADMIN_EMAILS is unset', async () => {
    projectRole.role = null;
    queueLoads(job, { email: ADMIN_EMAIL });

    expect((await post('cancel')).status).toBe(403);
  });
});

// cm:guard resume is deliberately NOT widened — reap is the only action the Operator Ops Console ships, so a platform admin who is a member of nothing must still get 403 here; delete this only alongside a caller that needs the widening (ISS-653)
describe('POST /:id/resume — not widened', () => {
  it('still refuses a platform admin who is a member of nothing', async () => {
    projectRole.role = null;
    testEnv.ADMIN_EMAILS = ADMIN_EMAIL;
    queueLoads({ ...job, status: 'held' });

    expect((await post('resume')).status).toBe(403);
    expect(resumeJobMock).not.toHaveBeenCalled();
  });
});
