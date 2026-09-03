import { beforeEach, describe, expect, it, vi } from 'vitest';

const limitResults: unknown[][] = [];
const limit = vi.fn(() => Promise.resolve(limitResults.shift() ?? []));
const where = vi.fn(() => ({ limit }));
const from = vi.fn(() => ({ where }));
const execute = vi.fn();
const updateReturning = vi.fn(() => Promise.resolve([] as unknown[]));
const updateWhere = vi.fn(() => ({ returning: updateReturning }));
const updateSet = vi.fn(() => ({ where: updateWhere }));

vi.mock('../db/client.js', () => ({
  db: {
    select: vi.fn(() => ({ from })),
    execute,
    update: vi.fn(() => ({ set: updateSet })),
  },
}));

const { isResumeFailedError, reclassifyAbortedResume } = await import('./handle-resume-failed.js');
const { CLASSIFIER_VERSION } = await import('../pipeline/failure-classifier.js');

beforeEach(() => {
  limitResults.length = 0;
  limit.mockClear();
  execute.mockReset();
  updateSet.mockClear();
  updateReturning.mockReset();
  updateReturning.mockResolvedValue([]);
});

describe('isResumeFailedError', () => {
  it('returns true for the [RESUME_FAILED] prefix', () => {
    expect(isResumeFailedError('[RESUME_FAILED] session not found')).toBe(true);
  });
  it('returns false for everything else', () => {
    expect(isResumeFailedError(null)).toBe(false);
    expect(isResumeFailedError(undefined)).toBe(false);
    expect(isResumeFailedError('')).toBe(false);
    expect(isResumeFailedError('session not found')).toBe(false);
    expect(isResumeFailedError('[USAGE_LIMIT] x')).toBe(false);
  });
});

// cm:guard `reclassifyAbortedResume` must write BOTH the reason and the kind, and stamp the classifier version — an aborted resume that keeps `failureKind: 'infra'` is read by the retry chain as a bad box and fails the job over to another one, where the same missing session id fails again.
describe('reclassifyAbortedResume', () => {
  it('rewrites the failure as code, stamped with the classifier version', async () => {
    updateReturning.mockResolvedValueOnce([{ id: 'j-1', failureKind: 'code' }]);

    const out = await reclassifyAbortedResume({ id: 'j-1' });

    expect(updateSet).toHaveBeenCalledWith({
      failureReason: 'resume_failed',
      failureKind: 'code',
      classifierVersion: CLASSIFIER_VERSION,
    });
    expect(out).toEqual({ id: 'j-1', failureKind: 'code' });
  });

  it('returns the row it was given when the write matched nothing', async () => {
    updateReturning.mockResolvedValueOnce([]);

    expect(await reclassifyAbortedResume({ id: 'j-1' })).toEqual({ id: 'j-1' });
  });
});
