import { beforeEach, describe, expect, it, vi } from 'vitest';

// ISS-669 — `released` must NOT close the issue's open pipeline_run (the
// release step needs to run inside it); only `closed` closes the run. This
// unit-tests `transitionIssueStatus` directly against a minimal db mock,
// asserting `closeOpenRunForIssue` fires exactly on the statuses in
// `RUN_CLOSING_STATUSES`.

const updateReturning = vi.fn();
const updateWhere = vi.fn(() => ({ returning: updateReturning }));
const updateSet = vi.fn(() => ({ where: updateWhere }));
const dbUpdate = vi.fn(() => ({ set: updateSet }));
const txExecute = vi.fn(async () => undefined);
// `markMergedIfLeavingBase` runs a `tx.select(...).from(...).where(...).limit(1)`
// read against `projects` before it decides whether to stamp `merged_at`; an
// empty row set resolves the default merge states and short-circuits it.
const selectLimit = vi.fn(async () => [] as unknown[]);
const selectWhere = vi.fn(() => ({ limit: selectLimit }));
const selectFrom = vi.fn(() => ({ where: selectWhere }));

vi.mock('../db/client.js', () => {
  const txStub = {
    select: vi.fn(() => ({ from: selectFrom })),
    update: dbUpdate,
    execute: txExecute,
  };
  return {
    db: {
      transaction: vi.fn(async (cb: (tx: typeof txStub) => unknown) => cb(txStub)),
    },
  };
});

vi.mock('../ws/server.js', () => ({
  roomManager: { publish: vi.fn() },
}));

const closeOpenRunForIssueMock = vi.fn(async () => undefined);
const setCurrentStepForOpenIssueRunMock = vi.fn(async () => undefined);
vi.mock('../pipeline/runs.js', () => ({
  closeOpenRunForIssue: (...args: unknown[]) => closeOpenRunForIssueMock(...args),
  setCurrentStepForOpenIssueRun: (...args: unknown[]) =>
    setCurrentStepForOpenIssueRunMock(...args),
}));

const { transitionIssueStatus, TERMINAL_FOR_DISPATCH, RUN_CLOSING_STATUSES } = await import(
  './apply-transition.js'
);

const ISSUE_ID = '11111111-1111-4111-8111-111111111111';
const PROJECT_ID = '22222222-2222-4222-8222-222222222222';
const ACTOR_ID = '33333333-3333-4333-8333-333333333333';

function queueUpdate(status: string, reopenCount = 0) {
  updateReturning.mockResolvedValueOnce([
    { id: ISSUE_ID, status, reopenCount, updatedAt: new Date() },
  ]);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('transitionIssueStatus — run-closing decoupled from terminal-for-dispatch (ISS-669)', () => {
  it('entering `released` does NOT close the open run but still reports terminal:true', async () => {
    queueUpdate('released');
    const result = await transitionIssueStatus(
      { id: ISSUE_ID, projectId: PROJECT_ID, status: 'tested', reopenCount: 0 },
      'released',
      { type: 'user', id: ACTOR_ID },
    );

    expect(result.terminal).toBe(true);
    expect(closeOpenRunForIssueMock).not.toHaveBeenCalled();
    expect(setCurrentStepForOpenIssueRunMock).toHaveBeenCalledWith(ISSUE_ID, 'released');
  });

  it('entering `closed` DOES close the open run', async () => {
    queueUpdate('closed');
    const result = await transitionIssueStatus(
      { id: ISSUE_ID, projectId: PROJECT_ID, status: 'released', reopenCount: 0 },
      'closed',
      { type: 'user', id: ACTOR_ID },
    );

    expect(result.terminal).toBe(true);
    expect(closeOpenRunForIssueMock).toHaveBeenCalledWith(ISSUE_ID, 'completed');
  });

  it('TERMINAL_FOR_DISPATCH still includes both released and closed (Layer-2 unblock unaffected)', () => {
    expect(TERMINAL_FOR_DISPATCH.has('released')).toBe(true);
    expect(TERMINAL_FOR_DISPATCH.has('closed')).toBe(true);
  });

  it('RUN_CLOSING_STATUSES contains only closed', () => {
    expect(RUN_CLOSING_STATUSES.has('closed')).toBe(true);
    expect(RUN_CLOSING_STATUSES.has('released')).toBe(false);
  });
});
