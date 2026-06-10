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
const updateReturningMock = vi.fn();
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
    update: () => ({
      set: (s: unknown) => {
        updateSetMock(s);
        return { where: () => ({ returning: () => updateReturningMock() }) };
      },
    }),
  },
}));

const { indexMemory, indexMemoryBestEffort } = await import('./indexer.js');

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';

beforeEach(() => {
  embedMock.mockReset();
  valuesMock.mockReset();
  conflictMock.mockReset();
  returningMock.mockReset();
  selectLimitMock.mockReset();
  updateSetMock.mockReset();
  updateReturningMock.mockReset();
  searchMemoriesMock.mockReset();
  warnMock.mockReset();
  embedMock.mockResolvedValue([0.1, 0.2]);
  returningMock.mockResolvedValue([{ id: 'm-1', embeddedAt: new Date() }]);
  selectLimitMock.mockResolvedValue([]);
  updateReturningMock.mockResolvedValue([{ id: 'm-existing', embeddedAt: new Date() }]);
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

describe('indexMemory semantic dedup', () => {
  const input = {
    projectId: PROJECT_ID,
    source: 'knowledge' as const,
    sourceRef: 'new-ref',
    text: 'always use python3',
  };

  it('does not search for duplicates when the option is off', async () => {
    await indexMemory(input);
    expect(searchMemoriesMock).not.toHaveBeenCalled();
  });

  it('absorbs the write into a near-identical existing row', async () => {
    searchMemoriesMock.mockResolvedValueOnce([
      { id: 'm-existing', sourceRef: 'old-ref', score: 0.93 },
    ]);

    const result = await indexMemory(input, { semanticDedup: true });

    expect(result.id).toBe('m-existing');
    expect(result.dedupedInto).toBe('old-ref');
    // No new row inserted.
    expect(valuesMock).not.toHaveBeenCalled();
    // The absorbing row is revived and refreshed.
    const set = updateSetMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(set.archivedAt).toBeNull();
    expect(set.textContent).toBe('always use python3');
  });

  it('skips dedup when the exact natural key already exists (upsert refines it)', async () => {
    selectLimitMock.mockResolvedValueOnce([{ id: 'm-1' }]);
    const result = await indexMemory(input, { semanticDedup: true });
    expect(searchMemoriesMock).not.toHaveBeenCalled();
    expect(result.dedupedInto).toBeUndefined();
    expect(valuesMock).toHaveBeenCalled();
  });

  it('inserts normally when the best match is below the threshold', async () => {
    searchMemoriesMock.mockResolvedValueOnce([{ id: 'm-far', sourceRef: 'far', score: 0.7 }]);
    const result = await indexMemory(input, { semanticDedup: true });
    expect(result.dedupedInto).toBeUndefined();
    expect(valuesMock).toHaveBeenCalled();
  });

  it('skips dedup on degraded writes (no vector to compare)', async () => {
    embedMock.mockRejectedValueOnce(new FakeEmbeddingUnavailableError('down'));
    const result = await indexMemory(input, { semanticDedup: true });
    expect(searchMemoriesMock).not.toHaveBeenCalled();
    expect(result.degraded).toBe(true);
  });

  it('falls back to a normal insert when the dedup target vanishes mid-flight', async () => {
    searchMemoriesMock.mockResolvedValueOnce([
      { id: 'm-doomed', sourceRef: 'old-ref', score: 0.93 },
    ]);
    // Concurrent delete/purge between the similarity search and the update.
    updateReturningMock.mockResolvedValueOnce([]);

    const result = await indexMemory(input, { semanticDedup: true });

    expect(result.dedupedInto).toBeUndefined();
    expect(result.id).toBe('m-1');
    expect(valuesMock).toHaveBeenCalled();
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
