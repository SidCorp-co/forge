// ISS-141 / ISS-886 — an autonomous project has no step that answers for
// `reopen` and no resume that answers for `waiting`, so an issue landed on
// either was queued for a driver that would never look at it. These tests
// assert each rewrite lands on a status the driver DOES read, without dropping
// what the park meant: the authored reason still fires against the requested
// status, the reopen counter still increments, and the `waitingKind` is still
// demanded.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { issues } from '../db/schema.js';

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
    insert: vi.fn(() => ({ values: vi.fn(async () => undefined) })),
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

const mintMock = vi.fn(async (..._a: unknown[]) => undefined);
vi.mock('./park-question.js', () => ({
  NEED_NOT_STATED: 'not stated',
  mintParkQuestion: (...a: unknown[]) => mintMock(...a),
}));

vi.mock('./transition-evidence.js', () => ({ checkTransitionEvidence: vi.fn(async () => null) }));
vi.mock('./merged-at.js', () => ({
  BASE_MERGE_STATE: 'awaiting_release',
  refuseUnshippedClose: vi.fn(async () => null),
}));
vi.mock('./pipeline-health.js', () => ({
  publishPipelineHealthChanged: vi.fn(async () => undefined),
}));

const { transitionIssueStatus } = await import('./apply-transition.js');

const ISSUE_ID = '11111111-1111-4111-8111-111111111111';
const PROJECT_ID = '22222222-2222-4222-8222-222222222222';
const ACTOR_ID = '33333333-3333-4333-8333-333333333333';
const DEVICE_ID = '44444444-4444-4444-8444-444444444444';

function projectRow(present: 'yes' | null) {
  projectSelectLimit.mockResolvedValueOnce(present ? [{ agentConfig: {} }] : []);
}

function queueUpdate(status: string) {
  updateReturning.mockResolvedValueOnce([
    { id: ISSUE_ID, status, reopenCount: 1, updatedAt: new Date() },
  ]);
}

const REOPEN_OPTS = { transitionReason: 'the bug is still live on production' };

beforeEach(() => {
  vi.clearAllMocks();
  projectSelectLimit.mockReset();
  projectSelectLimit.mockResolvedValue([]);
  updateReturning.mockReset();
  updateReturning.mockResolvedValue([]);
});

describe('reopen on an autonomous project', () => {
  it('leaves `reopen` at `reopen`, because it names a person and not a step', async () => {
    projectRow('yes');
    queueUpdate('reopen');

    const result = await transitionIssueStatus(
      { id: ISSUE_ID, projectId: PROJECT_ID, status: 'closed', reopenCount: 0 },
      'reopen',
      { type: 'user', id: ACTOR_ID },
      REOPEN_OPTS,
    );

    expect(updateSet.mock.calls[0]?.[0]).toMatchObject({ status: 'reopen' });
    expect(result.status).toBe('reopen');
    expect(setCurrentStepMock).toHaveBeenCalledWith(ISSUE_ID, 'reopen');
    expect(publishMock.mock.calls[0]?.[1]).toMatchObject({ data: { to: 'reopen' } });
  });

  it('still demands and posts the reopen reason', async () => {
    projectRow('yes');
    queueUpdate('reopen');

    await transitionIssueStatus(
      { id: ISSUE_ID, projectId: PROJECT_ID, status: 'closed', reopenCount: 0 },
      'reopen',
      { type: 'user', id: ACTOR_ID },
      REOPEN_OPTS,
    );

    expect(postReasonMock).toHaveBeenCalledWith(
      expect.objectContaining({ fromStatus: 'closed', toStatus: 'reopen' }),
      expect.anything(),
    );
  });

  it('refuses a reopen with no reason, exactly as it does on a staged project', async () => {
    projectRow('yes');

    await expect(
      transitionIssueStatus(
        { id: ISSUE_ID, projectId: PROJECT_ID, status: 'closed', reopenCount: 0 },
        'reopen',
        { type: 'user', id: ACTOR_ID },
      ),
    ).rejects.toThrow('TRANSITION_REASON_REQUIRED');
    expect(updateSet).not.toHaveBeenCalled();
  });

  it('still increments the reopen counter', async () => {
    projectRow('yes');
    queueUpdate('reopen');

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
  it('leaves `reopen` alone when the project row cannot be read', async () => {
    projectRow(null);
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

  it('reads no project row at all under the orchestrator skip, where neither the park resolver nor the criteria resolver can matter', async () => {
    queueUpdate('in_progress');

    await transitionIssueStatus(
      { id: ISSUE_ID, projectId: PROJECT_ID, status: 'open', reopenCount: 0 },
      'in_progress',
      { type: 'user', id: ACTOR_ID },
      { skip: true },
    );

    expect(dbSelect).not.toHaveBeenCalled();
    expect(updateSet.mock.calls[0]?.[0]?.reopenCount).toBe(issues.reopenCount);
  });

  it('reads the project exactly once for an actor-chosen target the park resolver ignores', async () => {
    projectRow(null);
    queueUpdate('in_progress');

    await transitionIssueStatus(
      { id: ISSUE_ID, projectId: PROJECT_ID, status: 'open', reopenCount: 0 },
      'in_progress',
      { type: 'user', id: ACTOR_ID },
    );

    expect(dbSelect).toHaveBeenCalledTimes(1);
  });
});

const WAITING_OPTS = {
  transitionReason: 'the fixture needs a real runner in an auth-dead state',
  waitingKind: 'needs_resource' as const,
};

describe('waiting on an autonomous project', () => {
  it("writes `needs_info` for an AGENT's park, the one park a human answer restarts", async () => {
    projectRow('yes');
    queueUpdate('needs_info');

    const result = await transitionIssueStatus(
      { id: ISSUE_ID, projectId: PROJECT_ID, status: 'in_progress', reopenCount: 0 },
      'waiting',
      { type: 'device', id: DEVICE_ID, ownerId: ACTOR_ID },
      WAITING_OPTS,
    );

    expect(updateSet.mock.calls[0]?.[0]).toMatchObject({ status: 'needs_info' });
    expect(result.status).toBe('needs_info');
    expect(setCurrentStepMock).toHaveBeenCalledWith(ISSUE_ID, 'needs_info');
  });

  it('clears waitingKind on the rewritten row while still demanding it up front', async () => {
    projectRow('yes');
    queueUpdate('needs_info');

    await transitionIssueStatus(
      { id: ISSUE_ID, projectId: PROJECT_ID, status: 'in_progress', reopenCount: 0 },
      'waiting',
      { type: 'device', id: DEVICE_ID, ownerId: ACTOR_ID },
      WAITING_OPTS,
    );

    expect(updateSet.mock.calls[0]?.[0]).toMatchObject({ waitingKind: null });
    expect(postReasonMock).toHaveBeenCalledWith(
      expect.objectContaining({ toStatus: 'waiting', waitingKind: 'needs_resource' }),
      expect.anything(),
    );
  });

  it('refuses an agent `waiting` with no kind, exactly as it does on a staged project', async () => {
    projectRow('yes');

    await expect(
      transitionIssueStatus(
        { id: ISSUE_ID, projectId: PROJECT_ID, status: 'in_progress', reopenCount: 0 },
        'waiting',
        { type: 'device', id: DEVICE_ID, ownerId: ACTOR_ID },
        { transitionReason: 'blocked on a decision' },
      ),
    ).rejects.toThrow('WAITING_KIND_REQUIRED');
    expect(updateSet).not.toHaveBeenCalled();
  });

  it("leaves a HUMAN's park at `waiting`", async () => {
    projectRow('yes');
    queueUpdate('waiting');

    const result = await transitionIssueStatus(
      { id: ISSUE_ID, projectId: PROJECT_ID, status: 'in_progress', reopenCount: 0 },
      'waiting',
      { type: 'user', id: ACTOR_ID },
      WAITING_OPTS,
    );

    expect(updateSet.mock.calls[0]?.[0]).toMatchObject({
      status: 'waiting',
      waitingKind: 'needs_resource',
    });
    expect(result.status).toBe('waiting');
  });

  it('leaves an agent `waiting` alone when the project row cannot be read', async () => {
    projectRow(null);
    queueUpdate('waiting');

    const result = await transitionIssueStatus(
      { id: ISSUE_ID, projectId: PROJECT_ID, status: 'developed', reopenCount: 0 },
      'waiting',
      { type: 'device', id: DEVICE_ID, ownerId: ACTOR_ID },
      WAITING_OPTS,
    );

    expect(updateSet.mock.calls[0]?.[0]).toMatchObject({
      status: 'waiting',
      waitingKind: 'needs_resource',
    });
    expect(result.status).toBe('waiting');
  });

  it('leaves `on_hold` alone even from a device actor', async () => {
    projectRow('yes');
    queueUpdate('on_hold');

    const result = await transitionIssueStatus(
      { id: ISSUE_ID, projectId: PROJECT_ID, status: 'in_progress', reopenCount: 0 },
      'on_hold',
      { type: 'device', id: DEVICE_ID, ownerId: ACTOR_ID },
    );

    expect(updateSet.mock.calls[0]?.[0]).toMatchObject({ status: 'on_hold' });
    expect(result.status).toBe('on_hold');
  });
});

describe('a waitingKind the write cannot keep', () => {
  it('refuses a kind sent with a `needs_info` request instead of nulling it in silence', async () => {
    projectRow(null);

    await expect(
      transitionIssueStatus(
        { id: ISSUE_ID, projectId: PROJECT_ID, status: 'tested', reopenCount: 0 },
        'needs_info',
        { type: 'device', id: DEVICE_ID, ownerId: ACTOR_ID },
        { transitionReason: 'the deploy fixture is missing', waitingKind: 'needs_decision' },
      ),
    ).rejects.toThrow('WAITING_KIND_NOT_APPLICABLE');
    expect(updateSet).not.toHaveBeenCalled();
  });

  it('refuses a kind sent with a target that demands no reason at all', async () => {
    projectRow(null);

    await expect(
      transitionIssueStatus(
        { id: ISSUE_ID, projectId: PROJECT_ID, status: 'tested', reopenCount: 0 },
        'in_progress',
        { type: 'device', id: DEVICE_ID, ownerId: ACTOR_ID },
        { waitingKind: 'needs_decision' },
      ),
    ).rejects.toThrow('WAITING_KIND_NOT_APPLICABLE');
    expect(updateSet).not.toHaveBeenCalled();
  });

  it('leaves a `needs_info` park carrying no kind untouched', async () => {
    projectRow(null);
    queueUpdate('needs_info');

    const result = await transitionIssueStatus(
      { id: ISSUE_ID, projectId: PROJECT_ID, status: 'tested', reopenCount: 0 },
      'needs_info',
      { type: 'device', id: DEVICE_ID, ownerId: ACTOR_ID },
      { transitionReason: 'the deploy fixture is missing' },
    );

    expect(result.status).toBe('needs_info');
    expect(updateSet.mock.calls[0]?.[0]).toMatchObject({ waitingKind: null });
  });

  it('leaves a `waiting` park carrying its kind untouched', async () => {
    projectRow(null);
    queueUpdate('waiting');

    const result = await transitionIssueStatus(
      { id: ISSUE_ID, projectId: PROJECT_ID, status: 'tested', reopenCount: 0 },
      'waiting',
      { type: 'device', id: DEVICE_ID, ownerId: ACTOR_ID },
      WAITING_OPTS,
    );

    expect(result.status).toBe('waiting');
    expect(updateSet.mock.calls[0]?.[0]).toMatchObject({ waitingKind: 'needs_resource' });
  });
});
