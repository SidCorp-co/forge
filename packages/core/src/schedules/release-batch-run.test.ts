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
    ['BatchInFlightError', new BatchInFlightError('in flight')],
    ['ClaimConflictError', new ClaimConflictError('claimed')],
    ['NoRunnerOnlineError', new NoRunnerOnlineError('no runner')],
    ['ReleasePoolEmptyError', new ReleasePoolEmptyError('empty pool')],
    ['NoReleaseGateError', new NoReleaseGateError('no gate')],
    ['ReleaseBranchesUndeclaredError', new ReleaseBranchesUndeclaredError('no branches')],
    ['ReleaseRecordMissingError', new ReleaseRecordMissingError('no note')],
  ])('classifies %s as skipped, not failed', async (_name, err) => {
    createReleaseBatchMock.mockRejectedValueOnce(err);
    const outcome = await cutWaitingRelease({ projectId: 'p1', userId: 'u1', issueIds: ['iss-1'] });
    expect(outcome.status).toBe('skipped');
    expect(outcome.output).toContain('no cut this tick');
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
    expect(outcome).toEqual({ status: 'skipped', output: 'this project has no release gate' });
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
    });
  });
});
