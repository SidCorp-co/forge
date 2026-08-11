import { beforeEach, describe, expect, it, vi } from 'vitest';

// ISS-786 child B, requirement 5 — the close-time `merged_at` audit comment
// must name whether any code evidence exists, so a false unblock (the
// ISS-75/76/77/78 shape) becomes visible instead of silent. This exercises
// only `transitionIssueStatus`'s comment-body branch; `markMergedOnClose`
// itself is covered by `issues/merged-at.test.ts` and stays untouched here.

const updateReturning = vi.fn();
const updateWhere = vi.fn(() => ({ returning: updateReturning }));
const updateSet = vi.fn(() => ({ where: updateWhere }));
const dbUpdate = vi.fn(() => ({ set: updateSet }));
const txExecute = vi.fn(async () => undefined);
const selectLimit = vi.fn(async () => [] as unknown[]);
const selectWhere = vi.fn(() => ({ limit: selectLimit }));
const selectFrom = vi.fn(() => ({ where: selectWhere }));

const insertValues = vi.fn(async (..._args: unknown[]) => undefined);
const dbInsert = vi.fn(() => ({ values: insertValues }));

vi.mock('../db/client.js', () => {
  const txStub = {
    select: vi.fn(() => ({ from: selectFrom })),
    update: dbUpdate,
    execute: txExecute,
  };
  return {
    db: {
      transaction: vi.fn(async (cb: (tx: typeof txStub) => unknown) => cb(txStub)),
      insert: dbInsert,
    },
  };
});

vi.mock('../ws/server.js', () => ({
  roomManager: { publish: vi.fn() },
}));

vi.mock('../pipeline/runs.js', () => ({
  closeOpenRunForIssue: vi.fn(async () => undefined),
  setCurrentStepForOpenIssueRun: vi.fn(async () => undefined),
}));

const collectWorkEvidenceMock = vi.fn();
vi.mock('../pipeline/work-evidence.js', async (importActual) => {
  const actual = await importActual<typeof import('../pipeline/work-evidence.js')>();
  return {
    ...actual,
    collectWorkEvidence: (...args: unknown[]) => collectWorkEvidenceMock(...args),
  };
});

const { transitionIssueStatus } = await import('./apply-transition.js');

const ISSUE_ID = '11111111-1111-4111-8111-111111111111';
const PROJECT_ID = '22222222-2222-4222-8222-222222222222';
const ACTOR_ID = '33333333-3333-4333-8333-333333333333';

function queueClosingUpdates() {
  // 1st update: the issues.status UPDATE.
  updateReturning.mockResolvedValueOnce([
    { id: ISSUE_ID, status: 'closed', reopenCount: 0, updatedAt: new Date() },
  ]);
  // 2nd update: `markMergedOnClose`'s stamp (fromStatus !== baseBranch short-
  // circuits `markMergedIfLeavingBase` before any update call).
  updateReturning.mockResolvedValueOnce([{ id: ISSUE_ID }]);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('transitionIssueStatus — close-time stamp audit comment names evidence (ISS-786 child B)', () => {
  it('keeps the existing generic text when code evidence exists', async () => {
    queueClosingUpdates();
    collectWorkEvidenceMock.mockResolvedValueOnce({
      implementationJobCount: 1,
      handoffCommitSha: 'abc123',
      handoffFilesModified: 2,
      branch: null,
    });

    await transitionIssueStatus(
      { id: ISSUE_ID, projectId: PROJECT_ID, status: 'developed', reopenCount: 0 },
      'closed',
      { type: 'user', id: ACTOR_ID },
    );

    expect(dbInsert).toHaveBeenCalled();
    const body = (insertValues.mock.calls[0]?.[0] as { body: string } | undefined)?.body;
    expect(body).toBe(
      'merged_at auto-stamped on close — `closed` counts as done, so `blocks`-dependents can now dispatch. ' +
        'If this issue was abandoned (its code never landed on the base branch), run `forge_issues` `unmark` to re-block dependents.',
    );
  });

  it('names the missing evidence when none is recorded', async () => {
    queueClosingUpdates();
    collectWorkEvidenceMock.mockResolvedValueOnce({
      implementationJobCount: 0,
      handoffCommitSha: null,
      handoffFilesModified: 0,
      branch: null,
    });

    await transitionIssueStatus(
      { id: ISSUE_ID, projectId: PROJECT_ID, status: 'developed', reopenCount: 0 },
      'closed',
      { type: 'user', id: ACTOR_ID },
    );

    const body = (insertValues.mock.calls[0]?.[0] as { body: string } | undefined)?.body;
    expect(body).toContain('No branch, commit or code handoff is recorded for this issue');
  });

  it('falls back to the evidence-assumed text when the evidence read fails (fail open)', async () => {
    queueClosingUpdates();
    collectWorkEvidenceMock.mockRejectedValueOnce(new Error('connection reset'));

    await transitionIssueStatus(
      { id: ISSUE_ID, projectId: PROJECT_ID, status: 'developed', reopenCount: 0 },
      'closed',
      { type: 'user', id: ACTOR_ID },
    );

    const body = (insertValues.mock.calls[0]?.[0] as { body: string } | undefined)?.body;
    expect(body).toContain('If this issue was abandoned');
  });
});
