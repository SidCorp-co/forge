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
const DEVICE_ID = '44444444-4444-4444-8444-444444444444';

// cm:guard `undefined` here means "this project's config is EMPTY", which since 2026-09-02 resolves to autonomous — it is no longer a way to spell "staged". A staged case must pass `'staged'`, and the two tests below that read as staged-by-omission were exactly the fleet's own bug in fixture form: 0 of 31 live projects had ever said `staged` either.
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
  // cm:why `clearAllMocks` clears calls but NOT a queued `mockResolvedValueOnce`, and the reason-required test queues a project row it never consumes — without this reset that row leaks into the next test and answers its lookup as if the project were autonomous
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
      expect.anything(),
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
    projectMode('staged');
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

  // cm:guard the resolver must stay behind the cheap `isRewritablePark` status test — it runs on EVERY transition from every surface, and moving the project read in front of that test adds a query to every status write in the product for the two targets that can use it
  it('reads no project row for a target that is neither `reopen` nor `waiting`', async () => {
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

const WAITING_OPTS = {
  transitionReason: 'the fixture needs a real runner in an auth-dead state',
  waitingKind: 'needs_resource' as const,
};

describe('waiting on an autonomous project', () => {
  it("writes `needs_info` for an AGENT's park, the one park a human answer restarts", async () => {
    projectMode('autonomous');
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

  // cm:guard the kind is cleared BECAUSE the row no longer says `waiting`, and leaving it set would render a "a human is needed" banner keyed to a status the issue is not in — the exact stale-kind failure the CLEAR arm in apply-transition.ts exists for
  it('clears waitingKind on the rewritten row while still demanding it up front', async () => {
    projectMode('autonomous');
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
    projectMode('autonomous');

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

  // cm:guard a person parking work owns their own resume; rewriting theirs to a comment-wakeable status would take the pause away from the human who chose it
  it("leaves a HUMAN's park at `waiting`", async () => {
    projectMode('autonomous');
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

  it("leaves core's decompose review gate at `waiting`", async () => {
    projectMode('autonomous');
    queueUpdate('waiting');

    const result = await transitionIssueStatus(
      { id: ISSUE_ID, projectId: PROJECT_ID, status: 'in_progress', reopenCount: 0 },
      'waiting',
      { type: 'device', id: DEVICE_ID, ownerId: ACTOR_ID },
      { ...WAITING_OPTS, waitingKind: 'needs_decision', viaDecomposeGate: true },
    );

    expect(updateSet.mock.calls[0]?.[0]).toMatchObject({
      status: 'waiting',
      waitingKind: 'needs_decision',
    });
    expect(result.status).toBe('waiting');
  });

  it('leaves an agent `waiting` alone on a staged project', async () => {
    projectMode('staged');
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

  // cm:guard `on_hold` is a human's deliberate pause and the ISS-411 operator cancel writes it with a DEVICE actor — rewriting it here would undo the authoritative cancel, so this asserts the rewrite stops at `waiting`
  it('leaves `on_hold` alone even from a device actor', async () => {
    projectMode('autonomous');
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
