import { beforeEach, describe, expect, it, vi } from 'vitest';
import { issues } from '../db/schema.js';

const updateReturning = vi.fn();
const updateWhere = vi.fn(() => ({ returning: updateReturning }));
const updateSet = vi.fn((..._args: unknown[]) => ({ where: updateWhere }));
const dbUpdate = vi.fn(() => ({ set: updateSet }));
const txExecute = vi.fn(async () => undefined);
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

const closeOpenRunForIssueMock = vi.fn(async (..._args: unknown[]) => undefined);
const setCurrentStepForOpenIssueRunMock = vi.fn(async (..._args: unknown[]) => undefined);
vi.mock('../pipeline/runs.js', () => ({
  closeOpenRunForIssue: (...args: unknown[]) => closeOpenRunForIssueMock(...args),
  setCurrentStepForOpenIssueRun: (...args: unknown[]) => setCurrentStepForOpenIssueRunMock(...args),
}));

const postReopenCapEscalationCommentMock = vi.fn(async (..._args: unknown[]) => undefined);
vi.mock('../jobs/park-comment.js', () => ({
  postReopenCapEscalationComment: (...args: unknown[]) =>
    postReopenCapEscalationCommentMock(...args),
}));

const pauseOpenRunForIssueMock = vi.fn(async (..._args: unknown[]) => null);
vi.mock('../pipeline/run-pause.js', () => ({
  pauseOpenRunForIssue: (...args: unknown[]) => pauseOpenRunForIssueMock(...args),
}));

const recordReopenCapEscalatedMock = vi.fn();
vi.mock('../observability/hold-metrics.js', () => ({
  recordReopenCapEscalated: () => recordReopenCapEscalatedMock(),
}));

const addBreadcrumbMock = vi.fn();
vi.mock('../observability/sentry.js', () => ({
  isSentryEnabled: () => false,
  Sentry: { addBreadcrumb: (...args: unknown[]) => addBreadcrumbMock(...args) },
}));

const { transitionIssueStatus, TransitionError } = await import('./apply-transition.js');

const ISSUE_ID = '11111111-1111-4111-8111-111111111111';
const PROJECT_ID = '22222222-2222-4222-8222-222222222222';
const DEVICE_ID = '33333333-3333-4333-8333-333333333333';
const OWNER_ID = '44444444-4444-4444-8444-444444444444';

function queueUpdate(status: string, reopenCount: number) {
  updateReturning.mockResolvedValueOnce([
    { id: ISSUE_ID, status, reopenCount, updatedAt: new Date() },
  ]);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('reopen cap escalation (ISS-766)', () => {
  it('device actor at the cap is redirected to `waiting`, not thrown', async () => {
    queueUpdate('waiting', 5);
    const result = await transitionIssueStatus(
      { id: ISSUE_ID, projectId: PROJECT_ID, status: 'developed', reopenCount: 5 },
      'reopen',
      { type: 'device', id: DEVICE_ID, ownerId: OWNER_ID },
    );
    expect(result.status).toBe('waiting');
    expect(result.capEscalated).toBe(true);
    expect(result.requestedStatus).toBe('reopen');
    expect(postReopenCapEscalationCommentMock).toHaveBeenCalledTimes(1);
    expect(postReopenCapEscalationCommentMock).toHaveBeenCalledWith(
      expect.objectContaining({ issueId: ISSUE_ID, reopenCount: 5, requestedStatus: 'reopen' }),
    );
    expect(pauseOpenRunForIssueMock).toHaveBeenCalledWith(
      expect.objectContaining({ issueId: ISSUE_ID, pauseReason: 'reopen_cap:developed' }),
    );
    expect(recordReopenCapEscalatedMock).toHaveBeenCalledTimes(1);
    const setArg = updateSet.mock.calls[0]?.[0] as { reopenCount: unknown };
    expect(setArg.reopenCount).toBe(issues.reopenCount);
  });

  it('posts the escalation comment before the status UPDATE (ordering contract)', async () => {
    const order: string[] = [];
    postReopenCapEscalationCommentMock.mockImplementationOnce(async () => {
      order.push('comment');
    });
    updateSet.mockImplementationOnce(() => {
      order.push('update');
      return { where: updateWhere };
    });
    queueUpdate('waiting', 5);
    await transitionIssueStatus(
      { id: ISSUE_ID, projectId: PROJECT_ID, status: 'testing', reopenCount: 5 },
      'reopen',
      { type: 'device', id: DEVICE_ID, ownerId: OWNER_ID },
    );
    expect(order).toEqual(['comment', 'update']);
  });

  it('user actor at the cap still throws REOPEN_CAP_EXCEEDED (422 REST contract unchanged)', async () => {
    await expect(
      transitionIssueStatus(
        { id: ISSUE_ID, projectId: PROJECT_ID, status: 'closed', reopenCount: 5 },
        'reopen',
        { type: 'user', id: DEVICE_ID },
      ),
    ).rejects.toBeInstanceOf(TransitionError);
    expect(postReopenCapEscalationCommentMock).not.toHaveBeenCalled();
    expect(pauseOpenRunForIssueMock).not.toHaveBeenCalled();
  });

  it('overrideReopenCap still forces a real reopen with the count incrementing', async () => {
    queueUpdate('reopen', 6);
    const result = await transitionIssueStatus(
      { id: ISSUE_ID, projectId: PROJECT_ID, status: 'developed', reopenCount: 5 },
      'reopen',
      { type: 'device', id: DEVICE_ID, ownerId: OWNER_ID },
      { overrideReopenCap: true },
    );
    expect(result.status).toBe('reopen');
    expect(result.capEscalated).toBe(false);
    expect(postReopenCapEscalationCommentMock).not.toHaveBeenCalled();
    const setArg = updateSet.mock.calls[0]?.[0] as { reopenCount: unknown };
    expect(setArg.reopenCount).not.toBe(issues.reopenCount);
  });

  it('below the cap, a device reopen is unaffected', async () => {
    queueUpdate('reopen', 3);
    const result = await transitionIssueStatus(
      { id: ISSUE_ID, projectId: PROJECT_ID, status: 'developed', reopenCount: 2 },
      'reopen',
      { type: 'device', id: DEVICE_ID, ownerId: OWNER_ID },
    );
    expect(result.status).toBe('reopen');
    expect(result.capEscalated).toBe(false);
    expect(postReopenCapEscalationCommentMock).not.toHaveBeenCalled();
  });
});
