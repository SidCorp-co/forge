import { beforeEach, describe, expect, it, vi } from 'vitest';
import { issues } from '../db/schema.js';

// ISS-141 — an autonomous project has no step that answers for `reopen`, so a
// reopened issue was queued for a driver that would never look at it. These
// tests assert the rewrite lands it on `open` WITHOUT dropping what a reopen
// means: the authored reason still fires against `reopen`, and the reopen
// counter still increments.

const updateReturning = vi.fn();
const updateWhere = vi.fn(() => ({ returning: updateReturning }));
const updateSet = vi.fn((_values: Record<string, unknown>) => ({ where: updateWhere }));
const dbUpdate = vi.fn(() => ({ set: updateSet }));
const txExecute = vi.fn(async () => undefined);
const txSelectLimit = vi.fn(async () => [] as unknown[]);
const txSelectWhere = vi.fn(() => ({ limit: txSelectLimit }));
const txSelectFrom = vi.fn(() => ({ where: txSelectWhere }));

const projectSelectLimit = vi.fn(async () => [] as unknown[]);
const projectSelectWhere = vi.fn(() => ({ limit: projectSelectLimit }));
const projectSelectFrom = vi.fn(() => ({ where: projectSelectWhere }));
const dbSelect = vi.fn(() => ({ from: projectSelectFrom }));

vi.mock('../db/client.js', () => {
  const txStub = {
    select: vi.fn(() => ({ from: txSelectFrom })),
    update: dbUpdate,
    execute: txExecute,
  };
  return {
    db: {
      select: dbSelect,
      transaction: vi.fn(async (cb: (tx: typeof txStub) => unknown) => cb(txStub)),
    },
  };
});

const publishMock = vi.fn();
vi.mock('../ws/server.js', () => ({
  roomManager: { publish: (...a: unknown[]) => publishMock(...a) },
}));

const setCurrentStepMock = vi.fn(async (..._a: unknown[]) => undefined);
vi.mock('../pipeline/runs.js', () => ({
  closeOpenRunForIssue: vi.fn(async () => undefined),
  setCurrentStepForOpenIssueRun: (...a: unknown[]) => setCurrentStepMock(...a),
}));

const postReasonMock = vi.fn(async (..._a: unknown[]) => undefined);
vi.mock('./transition-reason.js', async (importActual) => {
  const actual = await importActual<typeof import('./transition-reason.js')>();
  return { ...actual, postTransitionReasonComment: (...a: unknown[]) => postReasonMock(...a) };
});

vi.mock('./transition-evidence.js', () => ({ checkTransitionEvidence: vi.fn(async () => null) }));
vi.mock('./merged-at.js', () => ({
  markMergedIfLeavingBase: vi.fn(async () => undefined),
  markMergedOnClose: vi.fn(async () => ({ stamped: false })),
}));
vi.mock('./pipeline-health.js', () => ({
  publishPipelineHealthChanged: vi.fn(async () => undefined),
}));

const { transitionIssueStatus } = await import('./apply-transition.js');

const ISSUE_ID = '11111111-1111-4111-8111-111111111111';
const PROJECT_ID = '22222222-2222-4222-8222-222222222222';
const ACTOR_ID = '33333333-3333-4333-8333-333333333333';

function projectMode(mode: string | undefined) {
  projectSelectLimit.mockResolvedValueOnce([
    { agentConfig: mode ? { pipelineConfig: { mode } } : {} },
  ]);
}

function queueUpdate(status: string) {
  updateReturning.mockResolvedValueOnce([
    { id: ISSUE_ID, status, reopenCount: 1, updatedAt: new Date() },
  ]);
}

const REOPEN_OPTS = { transitionReason: 'the bug is still live on production' };

beforeEach(() => {
  vi.clearAllMocks();
  // `clearAllMocks` clears calls but NOT a queued `mockResolvedValueOnce`, and
  // the reason-required test queues a project row it never consumes — without
  // this reset that row leaks into the next test and answers its lookup.
  projectSelectLimit.mockReset();
  projectSelectLimit.mockResolvedValue([]);
  updateReturning.mockReset();
  updateReturning.mockResolvedValue([]);
});

describe('reopen on an autonomous project', () => {
  it('writes `open`, the one status the driver dispatches, instead of `reopen`', async () => {
    projectMode('autonomous');
    queueUpdate('open');

    const result = await transitionIssueStatus(
      { id: ISSUE_ID, projectId: PROJECT_ID, status: 'closed', reopenCount: 0 },
      'reopen',
      { type: 'user', id: ACTOR_ID },
      REOPEN_OPTS,
    );

    expect(updateSet.mock.calls[0]?.[0]).toMatchObject({ status: 'open' });
    expect(result.status).toBe('open');
    expect(setCurrentStepMock).toHaveBeenCalledWith(ISSUE_ID, 'open');
    expect(publishMock.mock.calls[0]?.[1]).toMatchObject({ data: { to: 'open' } });
  });

  it('still demands and posts the reopen reason, against `reopen` and not the rewritten target', async () => {
    projectMode('autonomous');
    queueUpdate('open');

    await transitionIssueStatus(
      { id: ISSUE_ID, projectId: PROJECT_ID, status: 'closed', reopenCount: 0 },
      'reopen',
      { type: 'user', id: ACTOR_ID },
      REOPEN_OPTS,
    );

    expect(postReasonMock).toHaveBeenCalledWith(
      expect.objectContaining({ fromStatus: 'closed', toStatus: 'reopen' }),
    );
  });

  it('refuses a reopen with no reason, exactly as it does on a staged project', async () => {
    projectMode('autonomous');

    await expect(
      transitionIssueStatus(
        { id: ISSUE_ID, projectId: PROJECT_ID, status: 'closed', reopenCount: 0 },
        'reopen',
        { type: 'user', id: ACTOR_ID },
      ),
    ).rejects.toThrow('TRANSITION_REASON_REQUIRED');
    expect(updateSet).not.toHaveBeenCalled();
  });

  // cm:guard the counter is the whole quality signal a reopen carries — an issue reopened four times is a pipeline failing at something, and a rewrite that lands on `open` without incrementing makes that indistinguishable from four fresh issues
  it('still increments the reopen counter', async () => {
    projectMode('autonomous');
    queueUpdate('open');

    await transitionIssueStatus(
      { id: ISSUE_ID, projectId: PROJECT_ID, status: 'closed', reopenCount: 0 },
      'reopen',
      { type: 'user', id: ACTOR_ID },
      REOPEN_OPTS,
    );

    expect(updateSet.mock.calls[0]?.[0]?.reopenCount).not.toBe(issues.reopenCount);
  });
});

describe('every other transition is untouched', () => {
  it('leaves `reopen` alone on a staged project', async () => {
    projectMode(undefined);
    queueUpdate('reopen');

    const result = await transitionIssueStatus(
      { id: ISSUE_ID, projectId: PROJECT_ID, status: 'closed', reopenCount: 0 },
      'reopen',
      { type: 'user', id: ACTOR_ID },
      REOPEN_OPTS,
    );

    expect(updateSet.mock.calls[0]?.[0]).toMatchObject({ status: 'reopen' });
    expect(result.status).toBe('reopen');
  });

  // cm:guard the resolver must stay behind the `reopen` check: this runs on EVERY transition from every surface, and a project read here would add a query per status write
  it('reads no project row for a target that is not `reopen`', async () => {
    queueUpdate('in_progress');

    await transitionIssueStatus(
      { id: ISSUE_ID, projectId: PROJECT_ID, status: 'open', reopenCount: 0 },
      'in_progress',
      { type: 'user', id: ACTOR_ID },
    );

    expect(dbSelect).not.toHaveBeenCalled();
    expect(updateSet.mock.calls[0]?.[0]?.reopenCount).toBe(issues.reopenCount);
  });
});
