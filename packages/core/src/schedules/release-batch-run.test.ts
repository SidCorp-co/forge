import { beforeEach, describe, expect, it, vi } from 'vitest';

interface RosterStub {
  gateStatus: string | null;
  channels: string[];
  releaseRunnerLabel: string | null;
  baseBranch: string | null;
  nextCutAt: string | null;
  currentVersion: string | null;
  issues: Array<{ id: string; claimedByRunId: string | null }>;
}
const loadReleaseRosterMock = vi.fn(
  async (_projectId: string): Promise<RosterStub> => ({
    gateStatus: 'awaiting_release',
    channels: [],
    releaseRunnerLabel: null,
    baseBranch: 'main',
    nextCutAt: null,
    currentVersion: null,
    issues: [],
  }),
);
vi.mock('../release-batch/queries.js', () => ({
  loadReleaseRoster: (projectId: string) => loadReleaseRosterMock(projectId),
}));

class BatchInFlightError extends Error {}
class ClaimConflictError extends Error {}
class NoRunnerOnlineError extends Error {}
class ReleasePoolEmptyError extends Error {}
class NoReleaseGateError extends Error {}
class ReleaseBranchesUndeclaredError extends Error {}
class ReleaseRecordMissingError extends Error {}

const createReleaseBatchMock = vi.fn(
  async (_args: { projectId: string; issueIds: string[]; userId: string }) => ({
    runId: 'run-1',
    jobId: 'job-1',
    issueIds: ['iss-1'],
    gateStatus: 'awaiting_release' as const,
    version: '1.0.0',
    ownerDeadlineAt: new Date().toISOString(),
  }),
);
vi.mock('../release-batch/service.js', () => ({
  createReleaseBatch: (args: { projectId: string; issueIds: string[]; userId: string }) =>
    createReleaseBatchMock(args),
  BatchInFlightError,
  ClaimConflictError,
  NoRunnerOnlineError,
  ReleasePoolEmptyError,
  NoReleaseGateError,
  ReleaseBranchesUndeclaredError,
  ReleaseRecordMissingError,
}));

vi.mock('../logger.js', () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));

const { cutWaitingRelease, runScheduledReleaseCut } = await import('./release-batch-run.js');

beforeEach(() => {
  createReleaseBatchMock.mockReset();
  createReleaseBatchMock.mockResolvedValue({
    runId: 'run-1',
    jobId: 'job-1',
    issueIds: ['iss-1'],
    gateStatus: 'awaiting_release',
    version: '1.0.0',
    ownerDeadlineAt: new Date().toISOString(),
  });
  loadReleaseRosterMock.mockReset();
  loadReleaseRosterMock.mockResolvedValue({
    gateStatus: 'awaiting_release',
    channels: [],
    releaseRunnerLabel: null,
    baseBranch: 'main',
    nextCutAt: null,
    currentVersion: null,
    issues: [],
  });
});

describe('cutWaitingRelease', () => {
  it('skips with no createReleaseBatch call when issueIds is empty', async () => {
    const outcome = await cutWaitingRelease({ projectId: 'p1', userId: 'u1', issueIds: [] });
    expect(outcome).toEqual({
      status: 'skipped',
      output: 'nothing is waiting at the release gate',
      named: [],
    });
    expect(createReleaseBatchMock).not.toHaveBeenCalled();
  });

  it('reports success naming the run it cut', async () => {
    const outcome = await cutWaitingRelease({ projectId: 'p1', userId: 'u1', issueIds: ['iss-1'] });
    expect(outcome.status).toBe('success');
    expect(outcome.output).toBe('cut 1 issue(s) as run run-1');
    expect(createReleaseBatchMock).toHaveBeenCalledWith({
      projectId: 'p1',
      issueIds: ['iss-1'],
      userId: 'u1',
    });
  });

  it.each([
    ['BatchInFlightError', new BatchInFlightError('in flight'), 'BATCH_IN_FLIGHT'],
    ['ClaimConflictError', new ClaimConflictError('claimed'), 'CLAIM_CONFLICT'],
    ['NoRunnerOnlineError', new NoRunnerOnlineError('no runner'), 'NO_RUNNER_ONLINE'],
    ['ReleasePoolEmptyError', new ReleasePoolEmptyError('empty pool'), 'RELEASE_POOL_EMPTY'],
    ['NoReleaseGateError', new NoReleaseGateError('no gate'), 'NO_RELEASE_GATE'],
    [
      'ReleaseBranchesUndeclaredError',
      new ReleaseBranchesUndeclaredError('no branches'),
      'RELEASE_BRANCHES_UNDECLARED',
    ],
    [
      'ReleaseRecordMissingError',
      new ReleaseRecordMissingError('no note'),
      'RELEASE_RECORD_MISSING',
    ],
  ])('classifies %s as skipped under its code, not failed', async (_name, err, code) => {
    createReleaseBatchMock.mockRejectedValueOnce(err);
    const outcome = await cutWaitingRelease({ projectId: 'p1', userId: 'u1', issueIds: ['iss-1'] });
    expect(outcome.status).toBe('skipped');
    expect(outcome.output).toContain('no cut this tick');
    expect(outcome.code).toBe(code);
    expect(outcome.reasons).toEqual([err.message]);
    expect(outcome.named).toEqual(['iss-1']);
  });

  it('prefers the code and every reason the refusal carries over the class', async () => {
    const err = Object.assign(new NoRunnerOnlineError('no runner'), {
      releaseBlockers: [
        { code: 'NO_RUNNER_ONLINE', message: 'No runner is online.' },
        { code: 'RELEASE_PROBES_UNDECLARED', message: 'The probes are undeclared.' },
      ],
    });
    createReleaseBatchMock.mockRejectedValueOnce(err);
    const outcome = await cutWaitingRelease({ projectId: 'p1', userId: 'u1', issueIds: ['iss-1'] });
    expect(outcome.code).toBe('NO_RUNNER_ONLINE');
    expect(outcome.reasons).toEqual(['No runner is online.', 'The probes are undeclared.']);
  });

  // `releaseBlockerError` throws a class per readiness code, most of them outside the list above
  // (`RELEASE_RUNNER_UNDECLARED` among them); what makes one a refusal is the blockers it carries.
  it('classifies any error carrying readiness blockers as a refusal under the first code', async () => {
    const sentence = 'This project declares a release model and no live deploy binding names one.';
    const err = Object.assign(new Error('RELEASE_RUNNER_UNDECLARED'), {
      releaseBlockers: [{ code: 'RELEASE_RUNNER_UNDECLARED', message: sentence }],
    });
    createReleaseBatchMock.mockRejectedValueOnce(err);
    const outcome = await cutWaitingRelease({ projectId: 'p1', userId: 'u1', issueIds: ['iss-1'] });
    expect(outcome.status).toBe('skipped');
    expect(outcome.code).toBe('RELEASE_RUNNER_UNDECLARED');
    expect(outcome.reasons).toEqual([sentence]);
    expect(outcome.named).toEqual(['iss-1']);
  });

  it('keeps an error carrying an empty blocker list unclassified', async () => {
    createReleaseBatchMock.mockRejectedValueOnce(
      Object.assign(new Error('lock timeout'), { releaseBlockers: [] }),
    );
    const outcome = await cutWaitingRelease({ projectId: 'p1', userId: 'u1', issueIds: ['iss-1'] });
    expect(outcome.status).toBe('failed');
  });

  // The enumerator refuses more than one release may carry, so the cut takes the
  // oldest fifty the roster lists first and leaves the rest for the next tick.
  it('names one release of the oldest merges when more are waiting than it may carry', async () => {
    const waiting = Array.from({ length: 75 }, (_, i) => `iss-${i}`);

    const outcome = await cutWaitingRelease({ projectId: 'p1', userId: 'u1', issueIds: waiting });

    expect(createReleaseBatchMock).toHaveBeenCalledWith({
      projectId: 'p1',
      issueIds: waiting.slice(0, 50),
      userId: 'u1',
    });
    expect(outcome.named).toEqual(waiting.slice(0, 50));
  });

  it('names the same fifty on a failure, so nothing reports on the tail it never sent', async () => {
    createReleaseBatchMock.mockRejectedValueOnce(new Error('advisory lock timeout'));
    const waiting = Array.from({ length: 75 }, (_, i) => `iss-${i}`);

    const outcome = await cutWaitingRelease({ projectId: 'p1', userId: 'u1', issueIds: waiting });

    expect(outcome.status).toBe('failed');
    expect(outcome.named).toEqual(waiting.slice(0, 50));
  });

  it('classifies an unrecognised error as failed, carrying the message', async () => {
    createReleaseBatchMock.mockRejectedValueOnce(new Error('advisory lock timeout'));
    const outcome = await cutWaitingRelease({ projectId: 'p1', userId: 'u1', issueIds: ['iss-1'] });
    expect(outcome.status).toBe('failed');
    expect(outcome.error).toBe('advisory lock timeout');
  });
});

describe('runScheduledReleaseCut — unchanged by the cutWaitingRelease extraction', () => {
  it('skips when the project has no release gate', async () => {
    loadReleaseRosterMock.mockResolvedValueOnce({
      gateStatus: null,
      channels: [],
      releaseRunnerLabel: null,
      baseBranch: null,
      nextCutAt: null,
      currentVersion: null,
      issues: [],
    });
    const outcome = await runScheduledReleaseCut({ projectId: 'p1', userId: 'u1' });
    expect(outcome).toEqual({
      status: 'skipped',
      output: 'this project has no release gate',
      named: [],
    });
    expect(createReleaseBatchMock).not.toHaveBeenCalled();
  });

  it('skips when nothing unclaimed is waiting', async () => {
    loadReleaseRosterMock.mockResolvedValueOnce({
      gateStatus: 'awaiting_release',
      channels: [],
      releaseRunnerLabel: null,
      baseBranch: 'main',
      nextCutAt: null,
      currentVersion: null,
      issues: [{ id: 'iss-1', claimedByRunId: 'run-already' }],
    });
    const outcome = await runScheduledReleaseCut({ projectId: 'p1', userId: 'u1' });
    expect(outcome).toEqual({
      status: 'skipped',
      output: 'nothing is waiting at the release gate',
      named: [],
    });
  });

  it('cuts every unclaimed waiting issue, ignoring already-claimed ones', async () => {
    loadReleaseRosterMock.mockResolvedValueOnce({
      gateStatus: 'awaiting_release',
      channels: [],
      releaseRunnerLabel: null,
      baseBranch: 'main',
      nextCutAt: null,
      currentVersion: null,
      issues: [
        { id: 'iss-1', claimedByRunId: null },
        { id: 'iss-2', claimedByRunId: 'run-already' },
        { id: 'iss-3', claimedByRunId: null },
      ],
    });
    await runScheduledReleaseCut({ projectId: 'p1', userId: 'u1' });
    expect(createReleaseBatchMock).toHaveBeenCalledWith({
      projectId: 'p1',
      issueIds: ['iss-1', 'iss-3'],
      userId: 'u1',
    });
  });

  it('reports a failed cut the same way cutWaitingRelease does', async () => {
    loadReleaseRosterMock.mockResolvedValueOnce({
      gateStatus: 'awaiting_release',
      channels: [],
      releaseRunnerLabel: null,
      baseBranch: 'main',
      nextCutAt: null,
      currentVersion: null,
      issues: [{ id: 'iss-1', claimedByRunId: null }],
    });
    createReleaseBatchMock.mockRejectedValueOnce(new Error('boom'));
    const outcome = await runScheduledReleaseCut({ projectId: 'p1', userId: 'u1' });
    expect(outcome).toEqual({
      status: 'failed',
      output: 'the scheduled cut failed',
      error: 'boom',
      named: ['iss-1'],
      reasons: ['boom'],
    });
  });
});
