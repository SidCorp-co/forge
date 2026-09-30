// The mock supports the call shape session-resume.ts uses: a db.execute for
// the context estimate.

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

const { estimateIssueContextTokens } = await import('./session-resume.js');

beforeEach(() => {
  selectLimitResults.length = 0;
  executeLimitResults.length = 0;
  whereArgs.length = 0;
  limitSpy.mockClear();
  where.mockClear();
  executeSpy.mockClear();
});

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
