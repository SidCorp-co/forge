// A write into a retired rung is refused by name, in the REST door as well as the guard: the rung is
// still in the enum for the rows that hold it, so nothing else would have said no.

import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ISSUE_STATUS_LABELS } from './status-sets.js';

const TEST_SECRET = 'test-secret-at-least-32-chars-long-abcdef';

// The archived-issue guard reads the row itself; these tests script every select, so it answers none.
vi.mock('./archive.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./archive.js')>()),
  archivedAmong: vi.fn(async () => []),
  archiveRefusalForTransition: vi.fn(async () => null),
}));

vi.mock('../config/env.js', () => ({
  env: { JWT_SECRET: TEST_SECRET, NODE_ENV: 'test' },
}));

const selectLimit = vi.fn();
const selectWhere = vi.fn(() => ({ limit: selectLimit }));
const dependentsAwait = vi.fn(async () => [] as unknown[]);
const dependentsWhere = vi.fn(() => dependentsAwait());
const dependentsInnerJoin = vi.fn(() => ({ where: dependentsWhere }));
const selectFrom = vi.fn(() => ({ where: selectWhere, innerJoin: dependentsInnerJoin }));

const updateReturning = vi.fn();
const updateWhere = vi.fn(() => ({ returning: updateReturning }));
const updateSet = vi.fn((_values: Record<string, unknown>) => ({ where: updateWhere }));
const dbUpdate = vi.fn(() => ({ set: updateSet }));

vi.mock('../db/client.js', () => {
  const txStub = {
    select: vi.fn(() => ({ from: selectFrom })),
    update: dbUpdate,
    insert: vi.fn(() => ({ values: async () => undefined })),
    execute: vi.fn(async () => undefined),
  };
  return {
    db: {
      select: vi.fn(() => ({ from: selectFrom })),
      update: dbUpdate,
      insert: vi.fn(() => ({ values: async () => undefined })),
      transaction: vi.fn(async (cb: (tx: typeof txStub) => unknown) => cb(txStub)),
    },
  };
});

vi.mock('../ws/server.js', () => ({ roomManager: { publish: vi.fn() } }));

const projectAccess = vi.fn();
vi.mock('../lib/authz.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/authz.js')>()),
  loadProjectAccess: (...args: unknown[]) => projectAccess(...args),
}));

const { transitionRoutes } = await import('./transition.js');
const { signUserToken } = await import('../auth/jwt.js');
const { errorHandler } = await import('../middleware/error.js');
const { requestId } = await import('../middleware/request-id.js');

const ISSUE_ID = '11111111-1111-4111-8111-111111111111';
const PROJECT_ID = '22222222-2222-4222-8222-222222222222';
const USER_ID = '33333333-3333-4333-8333-333333333333';

beforeEach(() => {
  vi.clearAllMocks();
  selectLimit.mockReset();
  selectLimit.mockResolvedValue([]);
  updateReturning.mockReset();
  projectAccess.mockReset();
  dependentsAwait.mockReset();
  dependentsAwait.mockResolvedValue([]);
});

function req(body: unknown, token: string) {
  const app = new Hono<{ Variables: import('../middleware/request-id.js').RequestIdVars }>();
  app.use('*', requestId());
  app.route('/api/issues', transitionRoutes);
  app.onError(errorHandler);
  return app.request(`/api/issues/${ISSUE_ID}/transition`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

function queueAuthAndIssue(status: string) {
  selectLimit.mockResolvedValueOnce([{ emailVerifiedAt: new Date() }]);
  selectLimit.mockResolvedValueOnce([
    { id: ISSUE_ID, projectId: PROJECT_ID, status, reopenCount: 0, issSeq: 1 },
  ]);
  projectAccess.mockResolvedValueOnce({
    projectId: PROJECT_ID,
    orgId: 'org-1',
    role: 'member',
    orgRole: null,
  });
}

describe('a status write into a retired rung', () => {
  it.each([
    ['clarified', 'approved'],
    ['tested', 'awaiting_release'],
  ] as const)('409 ILLEGAL_TRANSITION refuses %s, naming %s', async (retired, replacement) => {
    const token = await signUserToken(USER_ID);
    queueAuthAndIssue('in_progress');
    const res = await req({ toStatus: retired }, token);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string; message: string };
    expect(body.code).toBe('ILLEGAL_TRANSITION');
    expect(body.message).toContain(`${ISSUE_STATUS_LABELS[retired]} is a retired rung`);
    expect(body.message).toContain(`Write ${ISSUE_STATUS_LABELS[replacement]} instead`);
    expect(dbUpdate).not.toHaveBeenCalled();
  });

  it('moves an issue resting at a retired rung out, to the rung that took its place', async () => {
    const token = await signUserToken(USER_ID);
    queueAuthAndIssue('tested');
    updateReturning.mockResolvedValueOnce([
      { id: ISSUE_ID, status: 'awaiting_release', reopenCount: 0, updatedAt: new Date() },
    ]);
    const res = await req({ toStatus: 'awaiting_release' }, token);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { status: string }).status).toBe('awaiting_release');
  });
});
