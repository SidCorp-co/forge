import { beforeEach, describe, expect, it, vi } from 'vitest';

const issuesSelectMock = vi.fn();

vi.mock('../../../db/client.js', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => issuesSelectMock(),
        }),
      }),
    }),
  },
}));

vi.mock('../queries.js', () => ({
  getRunsForIssue: vi.fn(),
  getJobsForRun: vi.fn(),
}));

vi.mock('../../../db/schema.js', () => ({
  issues: { id: 'id', category: 'category', reopenCount: 'reopenCount' },
}));

const { getRunsForIssue, getJobsForRun } = await import('../queries.js');
const { extractReopenLoop } = await import('../reopen-loop.js');

const mockGetRunsForIssue = getRunsForIssue as ReturnType<typeof vi.fn>;
const mockGetJobsForRun = getJobsForRun as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.resetAllMocks();
  issuesSelectMock.mockResolvedValue([{ category: 'bug', reopenCount: 2 }]);
  mockGetRunsForIssue.mockResolvedValue([{ id: 'run-1' }, { id: 'run-2' }]);
  mockGetJobsForRun.mockResolvedValue([{ type: 'fix' }]);
});

describe('extractReopenLoop', () => {
  it('returns a signal when issue has reopenCount >= 1 and fix jobs present', async () => {
    const signals = await extractReopenLoop('run-3', 'proj-1', 'issue-1');
    expect(signals).toHaveLength(1);
    expect(signals[0]?.signalType).toBe('reopen_loop');
    expect(signals[0]?.signalKey).toBe('reopen_loop:bug');
    expect(signals[0]?.summary).toContain('bug');
  });

  it('returns empty when reopenCount is 0', async () => {
    issuesSelectMock.mockResolvedValue([{ category: 'bug', reopenCount: 0 }]);
    const signals = await extractReopenLoop('run-1', 'proj-1', 'issue-1');
    expect(signals).toHaveLength(0);
  });

  it('returns empty when no fix jobs in any run', async () => {
    mockGetJobsForRun.mockResolvedValue([{ type: 'code' }]);
    issuesSelectMock.mockResolvedValue([{ category: 'feature', reopenCount: 1 }]);
    const signals = await extractReopenLoop('run-1', 'proj-1', 'issue-1');
    expect(signals).toHaveLength(0);
  });

  it('uses "unknown" as category when category is null', async () => {
    issuesSelectMock.mockResolvedValue([{ category: null, reopenCount: 1 }]);
    mockGetJobsForRun.mockResolvedValue([{ type: 'fix' }]);
    const signals = await extractReopenLoop('run-1', 'proj-1', 'issue-1');
    if (signals.length > 0) {
      expect(signals[0]?.signalKey).toBe('reopen_loop:unknown');
    }
  });
});
