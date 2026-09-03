// The mock supports the two call shapes session-resume.ts uses: a
// select-from-where-limit for the bounds, and a db.execute for the context
// estimate.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const selectLimitResults: unknown[][] = [];
const executeLimitResults: unknown[][] = [];

const limitSpy = vi.fn(() => Promise.resolve(selectLimitResults.shift() ?? []));
const orderBy = vi.fn(() => ({ limit: limitSpy }));
const whereArgs: unknown[] = [];
const where = vi.fn((arg: unknown) => {
  whereArgs.push(arg);
  return { orderBy, limit: limitSpy };
});
const from = vi.fn(() => ({ where }));
const executeSpy = vi.fn(() => Promise.resolve(executeLimitResults.shift() ?? []));

vi.mock('../db/client.js', () => ({
  db: {
    select: vi.fn(() => ({ from })),
    execute: executeSpy,
  },
}));

const { loadResumeBounds, estimateIssueContextTokens } = await import('./session-resume.js');

beforeEach(() => {
  selectLimitResults.length = 0;
  executeLimitResults.length = 0;
  whereArgs.length = 0;
  limitSpy.mockClear();
  where.mockClear();
  executeSpy.mockClear();
});

describe('loadResumeBounds (ISS-580)', () => {
  it('returns defaults when project has no pipelineConfig', async () => {
    selectLimitResults.push([{ agentConfig: null }]);
    const bounds = await loadResumeBounds('p-1');
    expect(bounds).toEqual({ maxResumeTokens: 150_000, maxResumeReopenCycles: 3 });
  });

  it('returns defaults when pipelineConfig is missing the new fields', async () => {
    selectLimitResults.push([{ agentConfig: { pipelineConfig: { enabled: true } } }]);
    const bounds = await loadResumeBounds('p-1');
    expect(bounds).toEqual({ maxResumeTokens: 150_000, maxResumeReopenCycles: 3 });
  });

  it('returns configured values when both fields are present', async () => {
    selectLimitResults.push([
      {
        agentConfig: {
          pipelineConfig: { maxResumeTokens: 200_000, maxResumeReopenCycles: 5 },
        },
      },
    ]);
    const bounds = await loadResumeBounds('p-1');
    expect(bounds).toEqual({ maxResumeTokens: 200_000, maxResumeReopenCycles: 5 });
  });

  it('treats 0 as a valid (gate-disabled) value', async () => {
    selectLimitResults.push([
      {
        agentConfig: {
          pipelineConfig: { maxResumeTokens: 0, maxResumeReopenCycles: 0 },
        },
      },
    ]);
    const bounds = await loadResumeBounds('p-1');
    expect(bounds).toEqual({ maxResumeTokens: 0, maxResumeReopenCycles: 0 });
  });

  it('falls back to defaults on DB error', async () => {
    limitSpy.mockRejectedValueOnce(new Error('db down'));
    const bounds = await loadResumeBounds('p-1');
    expect(bounds).toEqual({ maxResumeTokens: 150_000, maxResumeReopenCycles: 3 });
  });
});

// cm:guard the estimate is scoped to the ISSUE, and that is deliberately broader than the one attempt a retry resumes: every session of an issue shares the transcript that attempt would reload, so the widest peak is the honest bound. A test that narrows the scope back to one session would pass while removing the ceiling.
describe('estimateIssueContextTokens', () => {
  it('returns 0 when no usage_records rows exist for the issue', async () => {
    executeLimitResults.push([{ peak: null }]);
    expect(await estimateIssueContextTokens('i-1')).toBe(0);
  });

  it('returns 0 when the query returns no rows', async () => {
    executeLimitResults.push([]);
    expect(await estimateIssueContextTokens('i-1')).toBe(0);
  });

  it('returns the numeric peak value from the MAX aggregate', async () => {
    executeLimitResults.push([{ peak: '363342' }]);
    expect(await estimateIssueContextTokens('i-1')).toBe(363342);
  });

  it('returns 0 on DB error (fail-safe — never blocks dispatch)', async () => {
    executeSpy.mockRejectedValueOnce(new Error('db down'));
    expect(await estimateIssueContextTokens('i-1')).toBe(0);
  });
});
