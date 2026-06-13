import { beforeEach, describe, expect, it, vi } from 'vitest';

const embedMock = vi.fn(async (_text: string) => Array.from({ length: 8 }, () => 0));
const searchMock = vi.fn();

vi.mock('../embeddings/index.js', () => ({
  embed: (...a: unknown[]) => embedMock(...(a as [string])),
}));
vi.mock('../memory/search.js', () => ({
  searchMemories: (...a: unknown[]) => searchMock(...(a as [])),
  // Usage tracking (memory-v2 phase 2) is fire-and-forget from the query path.
  touchMemories: async () => undefined,
}));

const { queryPreventivePatterns } = await import('./ci-fix-pattern-query.js');

beforeEach(() => {
  vi.clearAllMocks();
  searchMock.mockReset();
  embedMock.mockReset();
  embedMock.mockResolvedValue([0, 0, 0, 0]);
});

describe('queryPreventivePatterns', () => {
  it('returns [] when issueText is empty (UC-5 boundary)', async () => {
    const out = await queryPreventivePatterns({
      projectId: 'proj-1',
      issueText: '   ',
    });
    expect(out).toEqual([]);
    expect(embedMock).not.toHaveBeenCalled();
    expect(searchMock).not.toHaveBeenCalled();
  });

  it('returns [] when no matching memories exist', async () => {
    searchMock.mockResolvedValueOnce([]);
    const out = await queryPreventivePatterns({
      projectId: 'proj-1',
      issueText: 'add new endpoint',
    });
    expect(out).toEqual([]);
  });

  it('maps hits to PreventivePattern[] capped to maxPatterns', async () => {
    searchMock.mockResolvedValueOnce([
      {
        id: 'm-1',
        source: 'note',
        sourceRef: 'ci_fix_pattern:a:ts',
        text: 'a',
        metadata: {
          kind: 'ci_fix_pattern',
          errorTypes: ['a'],
          fileTypes: ['ts'],
          diffSummary: 'fix-1',
          branch: 'ISS-1',
        },
        score: 0.9,
        embeddedAt: new Date(),
      },
      {
        id: 'm-2',
        source: 'note',
        sourceRef: 'ci_fix_pattern:b:ts',
        text: 'b',
        metadata: {
          kind: 'ci_fix_pattern',
          errorTypes: ['b'],
          fileTypes: ['ts'],
          diffSummary: 'fix-2',
        },
        score: 0.8,
        embeddedAt: new Date(),
      },
      {
        id: 'm-3',
        source: 'note',
        sourceRef: 'ci_fix_pattern:c:ts',
        text: 'c',
        metadata: {
          kind: 'ci_fix_pattern',
          errorTypes: ['c'],
          fileTypes: ['ts'],
          diffSummary: 'fix-3',
        },
        score: 0.7,
        embeddedAt: new Date(),
      },
    ]);
    const out = await queryPreventivePatterns({
      projectId: 'proj-1',
      issueText: 'add new endpoint',
      maxPatterns: 2,
    });
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({
      errorTypes: ['a'],
      fileTypes: ['ts'],
      diffSummary: 'fix-1',
      branch: 'ISS-1',
      score: 0.9,
    });
    expect(out[1]?.errorTypes).toEqual(['b']);
  });

  it('filters out hits whose metadata.kind is not ci_fix_pattern', async () => {
    searchMock.mockResolvedValueOnce([
      {
        id: 'm-1',
        source: 'note',
        sourceRef: 'other',
        text: 'x',
        metadata: { kind: 'other' },
        score: 0.9,
        embeddedAt: new Date(),
      },
    ]);
    const out = await queryPreventivePatterns({
      projectId: 'proj-1',
      issueText: 'something',
    });
    expect(out).toEqual([]);
  });

  it('returns [] when embed throws (e.g. embeddings service unavailable)', async () => {
    embedMock.mockRejectedValueOnce(new Error('EMBEDDINGS_BASE_URL must be set'));
    const out = await queryPreventivePatterns({
      projectId: 'proj-1',
      issueText: 'something',
    });
    expect(out).toEqual([]);
  });

  it('returns [] when searchMemories throws', async () => {
    searchMock.mockRejectedValueOnce(new Error('db down'));
    const out = await queryPreventivePatterns({
      projectId: 'proj-1',
      issueText: 'something',
    });
    expect(out).toEqual([]);
  });
});
