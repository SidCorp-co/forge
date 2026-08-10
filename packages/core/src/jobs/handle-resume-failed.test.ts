import { beforeEach, describe, expect, it, vi } from 'vitest';

const limitResults: unknown[][] = [];
const limit = vi.fn(() => Promise.resolve(limitResults.shift() ?? []));
const where = vi.fn(() => ({ limit }));
const from = vi.fn(() => ({ where }));
const execute = vi.fn();
const updateWhere = vi.fn();
const updateSet = vi.fn(() => ({ where: updateWhere }));

vi.mock('../db/client.js', () => ({
  db: {
    select: vi.fn(() => ({ from })),
    execute,
    update: vi.fn(() => ({ set: updateSet })),
  },
}));

const { isResumeFailedError, handleResumeFailed } = await import(
  './handle-resume-failed.js'
);

beforeEach(() => {
  limitResults.length = 0;
  limit.mockClear();
  execute.mockReset();
  updateWhere.mockReset();
  updateWhere.mockResolvedValue(undefined);
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

describe('handleResumeFailed', () => {
  it('returns "fresh" with no work when payload has no sessionGroup', async () => {
    const r = await handleResumeFailed({
      id: 'j-1',
      projectId: 'p-1',
      issueId: 'i-1',
      payload: {},
    });
    expect(r).toBe('fresh');
    expect(execute).not.toHaveBeenCalled();
  });

  it('defaults to fresh when project has no agentConfig', async () => {
    limitResults.push([{ agentConfig: null }]);
    execute.mockResolvedValueOnce([]); // no prior sessions
    const r = await handleResumeFailed({
      id: 'j-1',
      projectId: 'p-1',
      issueId: 'i-1',
      payload: { sessionGroup: 'impl' },
    });
    expect(r).toBe('fresh');
  });

  it('returns "abort" when project sets onResumeFail=abort', async () => {
    limitResults.push([
      { agentConfig: { pipelineConfig: { onResumeFail: 'abort' } } },
    ]);
    execute.mockResolvedValueOnce([]); // no priors to invalidate
    const r = await handleResumeFailed({
      id: 'j-1',
      projectId: 'p-1',
      issueId: 'i-1',
      payload: { sessionGroup: 'impl' },
    });
    expect(r).toBe('abort');
  });

  it('invalidates prior sessions matching (issue, sessionGroup)', async () => {
    limitResults.push([{ agentConfig: {} }]);
    execute.mockResolvedValueOnce([{ id: 's-1' }, { id: 's-2' }]);
    await handleResumeFailed({
      id: 'j-1',
      projectId: 'p-1',
      issueId: 'i-1',
      payload: { sessionGroup: 'impl' },
    });
    expect(updateSet).toHaveBeenCalledTimes(2);
    expect(updateSet).toHaveBeenCalledWith({ claudeSessionId: null });
  });
});
