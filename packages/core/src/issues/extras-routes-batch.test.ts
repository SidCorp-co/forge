import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_SECRET = 'test-secret-at-least-32-chars-long-abcdef';

vi.mock('../config/env.js', () => ({
  env: { JWT_SECRET: TEST_SECRET, NODE_ENV: 'test' },
}));

// Chain for `db.select(...).from(...).where(...)` — awaitable directly so the
// batch endpoint's `inArray` lookup resolves to a row array. Also has `.limit`
// for the email-verified middleware path.
const selectAwait = vi.fn();
const selectWhere = vi.fn(() => {
  const limit = vi.fn(() => selectAwait());
  const thenable: PromiseLike<unknown> & { limit: typeof limit } = {
    limit,
    then: (resolve, reject) =>
      Promise.resolve(selectAwait()).then(resolve as never, reject as never),
  };
  return thenable;
});
const selectFrom = vi.fn(() => ({ where: selectWhere }));

// `db.update(table).set(values).where(cond)` is awaited directly by the
// plain-field path, OR chains `.returning({...})` for the status path. The
// where step is therefore both a thenable AND has a `.returning` method.
const updateReturning = vi.fn();
const updateWhere = vi.fn(() => {
  const thenable: PromiseLike<unknown> & { returning: typeof updateReturning } = {
    returning: updateReturning,
    then: (resolve, reject) =>
      Promise.resolve(undefined).then(resolve as never, reject as never),
  };
  return thenable;
});
const updateSet = vi.fn(() => ({ where: updateWhere }));
const updateMock = vi.fn((..._args: unknown[]) => ({ set: updateSet }));

// Tx proxy for manual-hold + plain-patch: `tx.update(...).set(...).where(...)`
// resolves directly (no .returning), and `tx.insert(...).values({...})` is the
// activity-log write.
//
// ISS-196 — the status UPDATE in extras-routes batch now also runs through
// `db.transaction(tx => withActorContext(tx, ..., t => t.update(...).returning(...)))`.
// We reuse the existing `updateMock` chain (which already supports both
// thenable-await and `.returning(...)`) for `tx.update` so status path mocks
// stay in `updateReturning`. The withActorContext helper calls
// `tx.execute(SELECT set_config(...))` first — `txExecute` is the noop stub.
const txExecute = vi.fn(async (..._args: unknown[]) => undefined);
const txInsertValues = vi.fn(async (..._args: unknown[]) => undefined);
const txInsert = vi.fn(() => ({ values: txInsertValues }));
// ISS-232 — `markMergedIfLeavingBase` issues a `tx.select(...).from
// (projects)...` to resolve `mergeStates`. Stub it as an empty resolve so
// the helper short-circuits with defaults under the in-memory db mock.
const txSelectLimit = vi.fn(async () => [] as unknown[]);
const txSelectWhere = vi.fn(() => ({ limit: txSelectLimit }));
const txSelectFrom = vi.fn(() => ({ where: txSelectWhere }));
const txSelect = vi.fn(() => ({ from: txSelectFrom }));
const txProxy = {
  update: updateMock,
  insert: txInsert,
  execute: txExecute,
  select: txSelect,
};
const transactionMock = vi.fn(
  async (cb: (tx: typeof txProxy) => Promise<unknown>) => cb(txProxy),
);
// Backwards-compat aliases for the older manual-hold / plain-patch test
// assertions that named these explicitly. They now point at the same chain
// the status UPDATE uses, so `txUpdate` calls === `updateMock` calls.
const txUpdate = updateMock;
const txUpdateSet = updateSet;
const txUpdateWhere = updateWhere;

// ISS-64 — `triggerTerminalDispatch` runs a single
// `db.select(...).from(issueDependencies).innerJoin(issues, ...).where(...)`
// query that returns enriched dependent rows
// `{ fromIssueId, toIssueId, depProjectId, toIssSeq }`.
const dependentsAwait = vi.fn(
  async () =>
    [] as Array<{
      fromIssueId: string;
      toIssueId: string;
      depProjectId: string;
      toIssSeq: number;
    }>,
);
const dependentsWhere = vi.fn(() => dependentsAwait());
const dependentsInnerJoin = vi.fn(() => ({ where: dependentsWhere }));

// Replace the original definition so `from()` exposes both the existing
// where-thenable path AND the innerJoin path used by triggerTerminalDispatch.
selectFrom.mockImplementation(() => ({
  where: selectWhere,
  innerJoin: dependentsInnerJoin,
}));

vi.mock('../db/client.js', () => ({
  db: {
    select: vi.fn(() => ({ from: selectFrom })),
    update: (...args: unknown[]) => updateMock(...args),
    transaction: (cb: (tx: typeof txProxy) => Promise<unknown>) => transactionMock(cb),
  },
}));

const projectAccess = vi.fn();
vi.mock('../lib/authz.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/authz.js')>()),
  loadProjectAccess: (...args: unknown[]) => projectAccess(...args),
}));

vi.mock('../jobs/enqueue.js', () => ({ enqueueJob: vi.fn() }));

const transitionEmit = vi.fn();
const issueUpdatedEmit = vi.fn();
vi.mock('../pipeline/hooks.js', () => ({
  hooks: {
    emit: (event: string, payload: unknown) => {
      if (event === 'transition') transitionEmit(payload);
      if (event === 'issueUpdated') issueUpdatedEmit(payload);
      return Promise.resolve();
    },
    on: vi.fn(),
  },
}));

const wsPublish = vi.fn();
vi.mock('../ws/server.js', () => ({
  roomManager: { publish: (...args: unknown[]) => wsPublish(...args) },
}));

// Mock dispatch-tick.js — extras-routes.ts now imports `triggerTerminalDispatch`
// from `./transition.js`, which transitively pulls pg-boss via dispatcher.ts.
// Mocking the leaf decouples this test from queue/runner module init.
const dispatchTick = vi.fn();
vi.mock('../jobs/dispatch-tick.js', () => ({
  dispatchTickForProject: (...args: unknown[]) => dispatchTick(...args),
}));

const { issueExtrasRoutes } = await import('./extras-routes.js');
const { signUserToken } = await import('../auth/jwt.js');
const { errorHandler } = await import('../middleware/error.js');
const { requestId } = await import('../middleware/request-id.js');

function buildApp() {
  const app = new Hono<{ Variables: import('../middleware/request-id.js').RequestIdVars }>();
  app.use('*', requestId());
  app.route('/api/issues', issueExtrasRoutes);
  app.onError(errorHandler);
  return app;
}

const USER_ID = '33333333-3333-4333-8333-333333333333';
const PROJECT_A = '22222222-2222-4222-8222-22222222aaaa';
const PROJECT_B = '22222222-2222-4222-8222-22222222bbbb';
const ISS1 = '11111111-1111-4111-8111-111111111111';
const ISS2 = '11111111-1111-4111-8111-111111111112';
const ISS3 = '11111111-1111-4111-8111-111111111113';

async function token() {
  return signUserToken(USER_ID);
}

function authVerified() {
  // requireAuth → assertEmailVerified runs `db.select(...).from(users).where(eq(...)).limit(1)`
  // The `then` handler on the where-thenable would resolve first if we used
  // selectAwait; but assertEmailVerified actually calls `.limit(1)`, so push a
  // `selectAwait` value matching `[{ emailVerifiedAt }]` for the limit step.
  selectAwait.mockResolvedValueOnce([{ emailVerifiedAt: new Date() }]);
}

beforeEach(() => {
  vi.clearAllMocks();
  selectAwait.mockReset();
  projectAccess.mockReset();
  updateReturning.mockReset();
  updateMock.mockClear();
  updateSet.mockClear();
  updateWhere.mockClear();
  txUpdate.mockClear();
  txUpdateSet.mockClear();
  txUpdateWhere.mockClear();
  txInsert.mockClear();
  txInsertValues.mockClear();
  transactionMock.mockClear();
  transitionEmit.mockClear();
  issueUpdatedEmit.mockClear();
  wsPublish.mockClear();
  dispatchTick.mockClear();
  dependentsAwait.mockReset();
  dependentsAwait.mockResolvedValue([]);
  dependentsInnerJoin.mockClear();
  dependentsWhere.mockClear();
});

const headers = async () => ({
  authorization: `Bearer ${await token()}`,
  'content-type': 'application/json',
});

describe('PATCH /api/issues/batch', () => {
  it('401 without token', async () => {
    const res = await buildApp().request('/api/issues/batch', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids: [ISS1], data: { priority: 'high' } }),
    });
    expect(res.status).toBe(401);
  });

  it('400 when ids is empty', async () => {
    authVerified();
    const res = await buildApp().request('/api/issues/batch', {
      method: 'PATCH',
      headers: await headers(),
      body: JSON.stringify({ ids: [], data: { priority: 'high' } }),
    });
    expect(res.status).toBe(400);
  });

  it('400 when data has no fields', async () => {
    authVerified();
    const res = await buildApp().request('/api/issues/batch', {
      method: 'PATCH',
      headers: await headers(),
      body: JSON.stringify({ ids: [ISS1], data: {} }),
    });
    expect(res.status).toBe(400);
  });

  it('updates priority on 3 issues — emits issueUpdated 3×', async () => {
    authVerified();
    selectAwait.mockResolvedValueOnce([
      { id: ISS1, issSeq: 1, projectId: PROJECT_A, status: 'open', priority: 'medium', category: null, complexity: null, reopenCount: 0 },
      { id: ISS2, issSeq: 2, projectId: PROJECT_A, status: 'open', priority: 'medium', category: null, complexity: null, reopenCount: 0 },
      { id: ISS3, issSeq: 3, projectId: PROJECT_A, status: 'open', priority: 'medium', category: null, complexity: null, reopenCount: 0 },
    ]);
    projectAccess.mockResolvedValueOnce({
      projectId: PROJECT_A,
      orgId: 'org-1',
      role: 'member',
      orgRole: null,
    });

    const res = await buildApp().request('/api/issues/batch', {
      method: 'PATCH',
      headers: await headers(),
      body: JSON.stringify({
        ids: [ISS1, ISS2, ISS3],
        data: { priority: 'high' },
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { updated: unknown[]; skipped: unknown[]; failed: unknown[] };
    expect(body.updated).toHaveLength(3);
    expect(body.skipped).toHaveLength(0);
    expect(body.failed).toHaveLength(0);
    expect(updateMock).toHaveBeenCalledTimes(3);
    expect(issueUpdatedEmit).toHaveBeenCalledTimes(3);
    // Distinct project access pre-loaded in parallel — for one shared project,
    // only one lookup runs.
    expect(projectAccess).toHaveBeenCalledTimes(1);
    // No terminal status transition → no Layer-2 dispatch tick.
    expect(dispatchTick).not.toHaveBeenCalled();
  });

  it('mixed status + priority — illegal transition surfaces as skipReason on the partially-applied row', async () => {
    authVerified();
    selectAwait.mockResolvedValueOnce([
      // ISS1 in `draft` cannot skip mid-pipeline to `in_progress` (drafts may
      // only be promoted to open or discarded to closed)
      { id: ISS1, issSeq: 1, projectId: PROJECT_A, status: 'draft', priority: 'medium', category: null, complexity: null, reopenCount: 0 },
      // ISS2 in `approved` can transition to `in_progress`
      { id: ISS2, issSeq: 2, projectId: PROJECT_A, status: 'approved', priority: 'medium', category: null, complexity: null, reopenCount: 0 },
    ]);
    projectAccess.mockResolvedValueOnce({
      projectId: PROJECT_A,
      orgId: 'org-1',
      role: 'member',
      orgRole: null,
    });
    // ISS2's status update returns its row.
    updateReturning.mockResolvedValueOnce([
      { id: ISS2, status: 'in_progress', reopenCount: 0, updatedAt: new Date() },
    ]);

    const res = await buildApp().request('/api/issues/batch', {
      method: 'PATCH',
      headers: await headers(),
      body: JSON.stringify({
        ids: [ISS1, ISS2],
        data: { status: 'in_progress', priority: 'high' },
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      updated: { id: string; skipReason?: string }[];
      skipped: { id: string; reason: string }[];
    };
    // Both rows had priority applied, so both end up in `updated`. ISS1's
    // illegal status request is surfaced via `skipReason` on the entry rather
    // than silently swallowed.
    expect(body.updated.map((u) => u.id).sort()).toEqual([ISS1, ISS2].sort());
    expect(body.skipped).toHaveLength(0);
    const iss1Entry = body.updated.find((u) => u.id === ISS1);
    expect(iss1Entry?.skipReason).toBe('illegal_transition');
    const iss2Entry = body.updated.find((u) => u.id === ISS2);
    expect(iss2Entry?.skipReason).toBeUndefined();
    // ISS-196 — the AFTER UPDATE trigger writes the outbox row; the legacy
    // inline hooks emit was removed. Assert the status UPDATE ran inside a
    // transaction (the outbox row is committed atomically with it).
    expect(transactionMock).toHaveBeenCalled();
    // Bug fix: batch must publish `issue.statusChanged` inline alongside the
    // status change (single-issue path does the same in transition.ts).
    expect(wsPublish).toHaveBeenCalledTimes(1);
    expect(wsPublish).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        event: 'issue.statusChanged',
        data: expect.objectContaining({ issueId: ISS2, from: 'approved', to: 'in_progress' }),
      }),
    );
  });

  it('id in a project the caller cannot access ends up skipped:forbidden', async () => {
    authVerified();
    selectAwait.mockResolvedValueOnce([
      { id: ISS1, issSeq: 1, projectId: PROJECT_A, status: 'open', priority: 'medium', category: null, complexity: null, reopenCount: 0 },
      { id: ISS2, issSeq: 2, projectId: PROJECT_B, status: 'open', priority: 'medium', category: null, complexity: null, reopenCount: 0 },
    ]);
    projectAccess.mockImplementation(async (projectId: string) => {
      if (projectId === PROJECT_A) {
        return { projectId, orgId: 'org-1', role: 'member', orgRole: null };
      }
      return { projectId, orgId: 'org-1', role: null, orgRole: null };
    });

    const res = await buildApp().request('/api/issues/batch', {
      method: 'PATCH',
      headers: await headers(),
      body: JSON.stringify({
        ids: [ISS1, ISS2],
        data: { priority: 'high' },
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      updated: { id: string }[];
      skipped: { id: string; reason: string }[];
    };
    expect(body.updated.map((u) => u.id)).toEqual([ISS1]);
    expect(body.skipped).toEqual([{ id: ISS2, reason: 'forbidden' }]);
  });

  it('terminal status transitions fan out Layer-2 dispatch ticks once per parent + child project', async () => {
    authVerified();
    selectAwait.mockResolvedValueOnce([
      // Two issues in PROJECT_A, both at `staging` → `released` (terminal).
      { id: ISS1, issSeq: 1, projectId: PROJECT_A, status: 'staging', priority: 'medium', category: null, complexity: null, reopenCount: 0 },
      { id: ISS2, issSeq: 2, projectId: PROJECT_A, status: 'staging', priority: 'medium', category: null, complexity: null, reopenCount: 0 },
    ]);
    projectAccess.mockResolvedValueOnce({
      projectId: PROJECT_A,
      orgId: 'org-1',
      role: 'member',
      orgRole: null,
    });
    updateReturning.mockResolvedValueOnce([
      { id: ISS1, status: 'released', reopenCount: 0, updatedAt: new Date() },
    ]);
    updateReturning.mockResolvedValueOnce([
      { id: ISS2, status: 'released', reopenCount: 0, updatedAt: new Date() },
    ]);
    // The fan-out dependents query returns rows in PROJECT_A (same project,
    // so deduped by parentProjectIds) AND in PROJECT_B (cross-project blocking
    // edge). The helper distincts child projects from parents on its own.
    dependentsAwait.mockResolvedValueOnce([
      { fromIssueId: ISS1, toIssueId: ISS3, depProjectId: PROJECT_A, toIssSeq: 11 },
      { fromIssueId: ISS2, toIssueId: ISS3, depProjectId: PROJECT_B, toIssSeq: 22 },
    ]);

    const res = await buildApp().request('/api/issues/batch', {
      method: 'PATCH',
      headers: await headers(),
      body: JSON.stringify({
        ids: [ISS1, ISS2],
        data: { status: 'released' },
      }),
    });
    expect(res.status).toBe(200);
    // Layer-2 fan-out: parent project ticked once (deduped across the two
    // terminal issues) + the distinct child project from the IN-list query.
    const calledProjects = dispatchTick.mock.calls.map((c) => c[0]).sort();
    expect(calledProjects).toEqual([PROJECT_A, PROJECT_B].sort());
    // Children query runs once with `inArray(fromIssueId, [ISS1, ISS2])` —
    // not once per terminal issue.
    expect(dependentsWhere).toHaveBeenCalledTimes(1);
    // Each dispatch tick carries a `triggerBlockerIssueId` so the dispatcher
    // can attribute any subsequent `dependency.unblocked` event.
    for (const call of dispatchTick.mock.calls) {
      const [, options] = call;
      expect(options).toMatchObject({ triggerBlockerIssueId: expect.any(String) });
    }
    // Two `issue.unblockCascade` events broadcast — one per terminal blocker
    // (ISS1, ISS2) since each has at least one outgoing `blocks` edge.
    const cascadeCalls = wsPublish.mock.calls.filter(
      (c) => (c[1] as { event: string }).event === 'issue.unblockCascade',
    );
    expect(cascadeCalls).toHaveLength(2);
    for (const [room, envelope] of cascadeCalls) {
      expect(room).toBe(`project:${PROJECT_A}`);
      const data = (envelope as { data: { dependents: Array<{ issSeq: number }> } }).data;
      expect(data.dependents).toHaveLength(1);
    }
  });
});
