// ISS-965 — `waitingKind` was accepted for every transition target and stored
// for exactly one of them. The REST contract is the half no type-checker
// covers: `transitionErrorToHttp` maps codes to status by hand, and a code it
// does not name falls through to the 409 default, so a refusal ships as a
// conflict. Measured by deleting the case: the request 409s and the body still
// carries the right code, which is the shape a caller cannot act on.

import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_SECRET = 'test-secret-at-least-32-chars-long-abcdef';

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

// cm:guard the two selectLimit queues are ORDER-COUPLED to the route: assertEmailVerified reads first, the issue row second — swap them and the route reads the issue row as its verification check, so the failure arrives as a 500 rather than the status under test
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

describe('a waitingKind the target cannot store', () => {
  // cm:guard 422 and not a silent 200: before ISS-965 this exact request was accepted, the kind was nulled by the CLEAR arm in apply-transition.ts, and the only observable effect was the status move — so a caller could not tell a stored park from a dropped one. Measured on 16 `needs_info` parks, 2026-09-07.
  it('422 WAITING_KIND_NOT_APPLICABLE on a `needs_info` park', async () => {
    const token = await signUserToken(USER_ID);
    queueAuthAndIssue('tested');

    const res = await req(
      {
        toStatus: 'needs_info',
        reason: 'the deploy fixture is missing',
        waitingKind: 'needs_decision',
      },
      token,
    );

    expect(res.status).toBe(422);
    expect(((await res.json()) as { code: string }).code).toBe('WAITING_KIND_NOT_APPLICABLE');
    expect(dbUpdate).not.toHaveBeenCalled();
  });

  // cm:guard the companion case: `in_progress` demands no authored reason, so it is the target a refusal nested in the reason block would miss entirely
  it('422 on a target that demands no reason at all', async () => {
    const token = await signUserToken(USER_ID);
    queueAuthAndIssue('tested');

    const res = await req({ toStatus: 'in_progress', waitingKind: 'needs_resource' }, token);

    expect(res.status).toBe(422);
    expect(((await res.json()) as { code: string }).code).toBe('WAITING_KIND_NOT_APPLICABLE');
    expect(dbUpdate).not.toHaveBeenCalled();
  });

  it('200 when the same park carries no kind', async () => {
    const token = await signUserToken(USER_ID);
    queueAuthAndIssue('tested');
    updateReturning.mockResolvedValueOnce([
      { id: ISSUE_ID, status: 'needs_info', reopenCount: 0, updatedAt: new Date() },
    ]);

    const res = await req(
      { toStatus: 'needs_info', reason: 'the deploy fixture is missing' },
      token,
    );

    expect(res.status).toBe(200);
    expect(updateSet.mock.calls[0]?.[0]).toMatchObject({ waitingKind: null });
  });
});
