// A nightly cut that cries failure on a quiet night is a cut people stop
// reading, and the next failure they ignore is a real one. These pin which
// outcomes are "not now" and which are actually broken.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const loadReleaseRoster = vi.fn();
const createReleaseBatch = vi.fn();

vi.mock('../release-batch/queries.js', () => ({ loadReleaseRoster: () => loadReleaseRoster() }));
// Fully replaced rather than spread over the real module: importing it for
// real pulls the db client and therefore the env contract, and this file has
// no database in it.
vi.mock('../release-batch/service.js', () => {
  class BatchInFlightError extends Error {
    constructor(public readonly existingJobId?: string | null) {
      super('BATCH_IN_FLIGHT');
    }
  }
  class ClaimConflictError extends Error {}
  class NoRunnerOnlineError extends Error {}
  class ReleasePoolEmptyError extends Error {
    constructor(public readonly label?: string) {
      super('RELEASE_POOL_EMPTY');
    }
  }
  class NoReleaseGateError extends Error {}
  return {
    createReleaseBatch: (...a: unknown[]) => createReleaseBatch(...a),
    BatchInFlightError,
    ClaimConflictError,
    NoRunnerOnlineError,
    ReleasePoolEmptyError,
    NoReleaseGateError,
  };
});

const { runScheduledReleaseCut } = await import('./release-batch-run.js');
const { BatchInFlightError, NoRunnerOnlineError, ReleasePoolEmptyError } = await import(
  '../release-batch/service.js'
);

const ARGS = { projectId: 'proj-1', userId: 'user-1' };

function roster(issues: Array<{ id: string; claimedByRunId?: string | null }>) {
  loadReleaseRoster.mockResolvedValue({
    gateStatus: 'tested',
    channel: null,
    releaseRunnerLabel: null,
    issues: issues.map((i) => ({ ...i, claimedByRunId: i.claimedByRunId ?? null })),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('the scheduled cut', () => {
  it('claims everything waiting', async () => {
    roster([{ id: 'a' }, { id: 'b' }]);
    createReleaseBatch.mockResolvedValue({ runId: 'run-1', issueIds: ['a', 'b'] });

    const out = await runScheduledReleaseCut(ARGS);

    expect(createReleaseBatch).toHaveBeenCalledWith(
      expect.objectContaining({ issueIds: ['a', 'b'] }),
    );
    expect(out.status).toBe('success');
  });

  // cm:guard the claim is a CAS over the whole list, so one already-claimed issue would reject the entire cut — a person pressing "Release now" a minute earlier must not cost the cron its night
  it('leaves out issues another batch already claimed', async () => {
    roster([{ id: 'a', claimedByRunId: 'other-run' }, { id: 'b' }]);
    createReleaseBatch.mockResolvedValue({ runId: 'run-1', issueIds: ['b'] });

    await runScheduledReleaseCut(ARGS);

    expect(createReleaseBatch).toHaveBeenCalledWith(expect.objectContaining({ issueIds: ['b'] }));
  });

  it('skips a quiet night without calling anything', async () => {
    roster([]);

    expect((await runScheduledReleaseCut(ARGS)).status).toBe('skipped');
    expect(createReleaseBatch).not.toHaveBeenCalled();
  });

  it('skips a project with no gate', async () => {
    loadReleaseRoster.mockResolvedValue({ gateStatus: null, issues: [] });

    expect((await runScheduledReleaseCut(ARGS)).status).toBe('skipped');
  });

  it.each([
    ['a batch already in flight', () => new BatchInFlightError('job-1')],
    ['no runner online at 04:00', () => new NoRunnerOnlineError()],
    ['the release box lost its label', () => new ReleasePoolEmptyError('epod-prod')],
  ])('reports "not now" rather than failure for %s', async (_name, make) => {
    roster([{ id: 'a' }]);
    createReleaseBatch.mockRejectedValue(make());

    expect((await runScheduledReleaseCut(ARGS)).status).toBe('skipped');
  });

  it('still fails loudly on something it does not recognise', async () => {
    roster([{ id: 'a' }]);
    createReleaseBatch.mockRejectedValue(new Error('the database went away'));

    const out = await runScheduledReleaseCut(ARGS);

    expect(out.status).toBe('failed');
    expect(out.error).toContain('database');
  });
});
