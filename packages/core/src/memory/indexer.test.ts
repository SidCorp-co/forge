import { beforeEach, describe, expect, it, vi } from 'vitest';

const embedMock = vi.fn();

class FakeEmbeddingUnavailableError extends Error {}

vi.mock('../embeddings/index.js', () => ({
  embed: (text: string) => embedMock(text),
  EmbeddingUnavailableError: FakeEmbeddingUnavailableError,
}));

const warnMock = vi.fn();
vi.mock('../logger.js', () => ({
  logger: {
    warn: (...args: unknown[]) => warnMock(...args),
    error: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
}));

const searchMemoriesMock = vi.fn();
vi.mock('./search.js', () => ({
  searchMemories: (input: unknown) => searchMemoriesMock(input),
}));

// Chainable stubs for the drizzle call shapes the indexer uses.
const valuesMock = vi.fn();
const conflictMock = vi.fn();
const returningMock = vi.fn();
const selectLimitMock = vi.fn();
const updateSetMock = vi.fn();
vi.mock('../db/client.js', () => ({
  db: {
    insert: () => ({
      values: (v: unknown) => {
        valuesMock(v);
        return {
          onConflictDoUpdate: (cfg: unknown) => {
            conflictMock(cfg);
            return { returning: () => returningMock() };
          },
        };
      },
    }),
    select: () => ({
      from: () => ({
        where: () => ({ limit: () => selectLimitMock() }),
      }),
    }),
    // cm:guard ISS-876: the indexer must never UPDATE a row other than the one its natural key upserts — this stub exists purely so a reintroduced absorb is caught by `expect(updateSetMock).not.toHaveBeenCalled()` instead of passing silently
    update: () => ({
      set: (s: unknown) => {
        updateSetMock(s);
        return { where: () => ({ returning: async () => [] }) };
      },
    }),
  },
}));

const { NEAR_DUPLICATE_THRESHOLD, indexMemory, indexMemoryBestEffort } = await import(
  './indexer.js'
);

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';

beforeEach(() => {
  embedMock.mockReset();
  valuesMock.mockReset();
  conflictMock.mockReset();
  returningMock.mockReset();
  selectLimitMock.mockReset();
  updateSetMock.mockReset();
  searchMemoriesMock.mockReset();
  warnMock.mockReset();
  embedMock.mockResolvedValue([0.1, 0.2]);
  returningMock.mockResolvedValue([{ id: 'm-1', embeddedAt: new Date() }]);
  selectLimitMock.mockResolvedValue([]);
  searchMemoriesMock.mockResolvedValue([]);
});

describe('indexMemory', () => {
  it('stores the full text but embeds only the first 8192 chars', async () => {
    const longText = 'x'.repeat(10_000);
    const result = await indexMemory({
      projectId: PROJECT_ID,
      source: 'note',
      sourceRef: 'n-1',
      text: longText,
    });

    expect(result.truncated).toBe(true);
    expect(result.degraded).toBe(false);
    expect(embedMock).toHaveBeenCalledWith('x'.repeat(8192));
    const stored = valuesMock.mock.calls[0]?.[0] as { textContent: string };
    expect(stored.textContent).toHaveLength(10_000);
  });

  it('does not flag truncation for short text', async () => {
    const result = await indexMemory({
      projectId: PROJECT_ID,
      source: 'note',
      sourceRef: 'n-2',
      text: 'short',
    });
    expect(result.truncated).toBe(false);
    expect(embedMock).toHaveBeenCalledWith('short');
  });

  it('stores a degraded row (embedding null) when embeddings are unavailable', async () => {
    embedMock.mockRejectedValueOnce(new FakeEmbeddingUnavailableError('service down'));
    const result = await indexMemory({
      projectId: PROJECT_ID,
      source: 'note',
      sourceRef: 'n-3',
      text: 'survives the outage',
    });

    expect(result.degraded).toBe(true);
    const stored = valuesMock.mock.calls[0]?.[0] as { embedding: number[] | null };
    expect(stored.embedding).toBeNull();
    // embeddedAt must NOT advance on the conflict path for degraded writes.
    const conflictSet = (conflictMock.mock.calls[0]?.[0] as { set: Record<string, unknown> }).set;
    expect('embeddedAt' in conflictSet).toBe(false);
  });

  it('rethrows non-outage embed errors', async () => {
    embedMock.mockRejectedValueOnce(new Error('dimension mismatch'));
    await expect(
      indexMemory({ projectId: PROJECT_ID, source: 'note', sourceRef: 'n-4', text: 't' }),
    ).rejects.toThrow('dimension mismatch');
  });
});

describe('indexMemory near-duplicate probe', () => {
  const input = {
    projectId: PROJECT_ID,
    source: 'knowledge' as const,
    sourceRef: 'new-ref',
    text: 'always use python3',
  };

  it('does not probe when the option is off', async () => {
    await indexMemory(input);
    expect(searchMemoriesMock).not.toHaveBeenCalled();
  });

  // cm:guard ISS-876: the probe may only REPORT — the write must land on the ref the caller named and no other row may be touched; the absorb this replaced overwrote 4 of 6 dated summary rows on forge-dev and returned an archived snapshot ref that forge_memory.get could not read
  it('writes the ref the caller named and leaves the near-identical row untouched', async () => {
    searchMemoriesMock.mockResolvedValueOnce([
      { id: 'm-existing', sourceRef: 'old-ref', score: 0.93 },
    ]);

    const result = await indexMemory(input, { nearDuplicateProbe: true });

    expect(valuesMock.mock.calls[0]?.[0]).toMatchObject({ sourceRef: 'new-ref' });
    expect(updateSetMock).not.toHaveBeenCalled();
    expect(result.nearDuplicateOf).toBe('old-ref');
    expect(result.dedupeScore).toBe(0.93);
  });

  it('reports nothing at exactly the threshold (strictly-above only)', async () => {
    searchMemoriesMock.mockResolvedValueOnce([
      { id: 'm-edge', sourceRef: 'edge-ref', score: NEAR_DUPLICATE_THRESHOLD },
    ]);

    const result = await indexMemory(input, { nearDuplicateProbe: true });

    expect(result.nearDuplicateOf).toBeUndefined();
    expect(updateSetMock).not.toHaveBeenCalled();
    expect(valuesMock.mock.calls[0]?.[0]).toMatchObject({ sourceRef: 'new-ref' });
  });

  it('skips the probe when the exact natural key already exists (that write refines its own row)', async () => {
    selectLimitMock.mockResolvedValueOnce([{ id: 'm-1' }]);
    const result = await indexMemory(input, { nearDuplicateProbe: true });
    expect(searchMemoriesMock).not.toHaveBeenCalled();
    expect(result.nearDuplicateOf).toBeUndefined();
    expect(valuesMock).toHaveBeenCalled();
  });

  it('reports nothing when the best match is below the threshold', async () => {
    searchMemoriesMock.mockResolvedValueOnce([{ id: 'm-far', sourceRef: 'far', score: 0.7 }]);
    const result = await indexMemory(input, { nearDuplicateProbe: true });
    expect(result.nearDuplicateOf).toBeUndefined();
    expect(valuesMock).toHaveBeenCalled();
  });

  it('skips the probe on degraded writes (no vector to compare)', async () => {
    embedMock.mockRejectedValueOnce(new FakeEmbeddingUnavailableError('down'));
    const result = await indexMemory(input, { nearDuplicateProbe: true });
    expect(searchMemoriesMock).not.toHaveBeenCalled();
    expect(result.degraded).toBe(true);
    expect(updateSetMock).not.toHaveBeenCalled();
  });
});

describe('indexMemoryBestEffort', () => {
  it('swallows DB failures with a warn log', async () => {
    returningMock.mockRejectedValueOnce(new Error('connection refused'));
    await indexMemoryBestEffort({
      projectId: PROJECT_ID,
      source: 'note',
      sourceRef: 'n-5',
      text: 't',
    });
    expect(warnMock).toHaveBeenCalledWith(
      expect.objectContaining({ sourceRef: 'n-5' }),
      'memory.indexer: write failed',
    );
  });
});
