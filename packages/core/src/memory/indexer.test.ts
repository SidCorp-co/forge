import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
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

// cm:why the memory model is STATED rather than read: without this stub the flag read shares the `select` chain with the skip's row pre-read and the near-duplicate probe's exact-key read, so a case would be answering about whichever of the three consumed the queue first.
const flagsMock = vi.fn();
vi.mock('./retrieval-flags.js', () => ({
  loadRetrievalFlags: (projectId: string) => flagsMock(projectId),
  RETRIEVAL_FLAGS_OFF: { rerank: false, expandRelations: false, memoryModel: 'flat' },
}));

const chunkSetMatchesMock = vi.fn();
const invalidateChunksMock = vi.fn();
const chunkAndPublishMock = vi.fn();
vi.mock('./chunk-writer.js', () => ({
  chunkContextPrefix: async () => 'Note n-1',
  chunkSetMatches: (...a: unknown[]) => chunkSetMatchesMock(...a),
  invalidateChunks: (...a: unknown[]) => invalidateChunksMock(...a),
  chunkAndPublish: (...a: unknown[]) => chunkAndPublishMock(...a),
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
    transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
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
      }),
  },
}));

const { NEAR_DUPLICATE_THRESHOLD, indexMemory, indexMemoryBestEffort } = await import(
  './indexer.js'
);

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';

/** The `set` of the nth ON CONFLICT clause, named rather than read off a maybe-undefined call. */
function conflictSet(n: number): Record<string, unknown> {
  const call = conflictMock.mock.calls[n];
  if (!call) throw new Error(`indexer.test: no ON CONFLICT clause at call ${n}`);
  return (call[0] as { set: Record<string, unknown> }).set;
}

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
  returningMock.mockResolvedValue([landed()]);
  selectLimitMock.mockResolvedValue([]);
  searchMemoriesMock.mockResolvedValue([]);
  flagsMock.mockResolvedValue({ rerank: false, expandRelations: false, memoryModel: 'flat' });
  chunkSetMatchesMock.mockReset();
  invalidateChunksMock.mockReset();
  chunkAndPublishMock.mockReset();
  chunkSetMatchesMock.mockResolvedValue(false);
  invalidateChunksMock.mockResolvedValue(7);
  chunkAndPublishMock.mockResolvedValue({ chunks: 1, published: true });
});

/** The row the upsert returns — the landed values the skip's swap and the chunk check both read. */
function landed(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'm-1',
    embeddedAt: new Date(),
    textContent: 'landed text',
    metadata: {},
    chunkGeneration: 6,
    chunkedAt: null,
    hasEmbedding: true,
    ...over,
  };
}

/** A row already in the table, as the pre-read sees it. */
const stored = (textContent: string, hasEmbedding = true) => [{ textContent, hasEmbedding }];

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
    // cm:why embeddedAt must NOT advance on the conflict path for a degraded write: no vector was
    // written, so a fresh stamp would date a row the backfill has yet to embed.
    expect('embeddedAt' in conflictSet(0)).toBe(false);
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
    // cm:why two queued answers, in order: the skip's pre-read (different text, so the embed still happens), then the probe's own exact-key read.
    selectLimitMock
      .mockResolvedValueOnce(stored('something else'))
      .mockResolvedValueOnce([{ id: 'm-1' }]);
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

// cm:guard each case here names what the vector is DERIVED from, never the field that happens to be handy: a skip that is wrong about that leaves a stale vector and nothing anywhere goes red about it (ISS-1024).
describe('indexMemory does not re-embed text that did not change', () => {
  const input = {
    projectId: PROJECT_ID,
    source: 'note' as const,
    sourceRef: 'n-skip',
    text: 'the runner claims a slot',
  };

  it('makes no embed call when the stored text equals the incoming text and the row holds a vector', async () => {
    selectLimitMock.mockResolvedValueOnce(stored(input.text));
    const result = await indexMemory(input);
    expect(embedMock).not.toHaveBeenCalled();
    expect(result.degraded).toBe(false);
    expect(valuesMock).toHaveBeenCalledTimes(1);
  });

  it('embeds when the stored text differs from the incoming text', async () => {
    selectLimitMock.mockResolvedValueOnce(stored('the runner releases a slot'));
    await indexMemory(input);
    expect(embedMock).toHaveBeenCalledWith(input.text);
  });

  it('embeds against a stored row that holds no vector, even on identical text', async () => {
    selectLimitMock.mockResolvedValueOnce(stored(input.text, false));
    await indexMemory(input);
    expect(embedMock).toHaveBeenCalledWith(input.text);
  });

  it('embeds when the natural key has no stored row', async () => {
    selectLimitMock.mockResolvedValueOnce([]);
    await indexMemory(input);
    expect(embedMock).toHaveBeenCalledWith(input.text);
  });

  it('does not advance embedded_at on the skip, because no vector was written', async () => {
    selectLimitMock.mockResolvedValueOnce(stored(input.text));
    await indexMemory(input);
    expect('embeddedAt' in conflictSet(0)).toBe(false);
  });

  // cm:guard the swap, not the skip, is what keeps a lost race from lying: the upsert answers
  // `hasEmbedding: false` because its CASE refused to carry a vector for text that had moved.
  it('re-embeds the text that landed when the swap refuses the skip', async () => {
    selectLimitMock
      .mockResolvedValueOnce(stored(input.text))
      .mockResolvedValueOnce(stored(input.text));
    returningMock
      .mockResolvedValueOnce([landed({ hasEmbedding: false })])
      .mockResolvedValueOnce([landed({ hasEmbedding: true })]);
    const result = await indexMemory(input);
    expect(embedMock).toHaveBeenCalledTimes(1);
    expect(embedMock).toHaveBeenCalledWith(input.text);
    expect(valuesMock).toHaveBeenCalledTimes(2);
    expect(result.degraded).toBe(false);
  });

  it('reports degraded, not a vector, when the forced re-embed after a lost race hits an outage', async () => {
    selectLimitMock.mockResolvedValueOnce(stored(input.text));
    returningMock
      .mockResolvedValueOnce([landed({ hasEmbedding: false })])
      .mockResolvedValueOnce([landed({ hasEmbedding: false })]);
    embedMock.mockRejectedValueOnce(new FakeEmbeddingUnavailableError('down'));
    const result = await indexMemory(input);
    expect(result.degraded).toBe(true);
    const written = valuesMock.mock.calls[1]?.[0] as { embedding: number[] | null };
    expect(written.embedding).toBeNull();
  });
});

describe('indexMemory leaves a chunk set alone only where it is the set this write would build', () => {
  const input = {
    projectId: PROJECT_ID,
    source: 'issue' as const,
    sourceRef: 'i-1',
    text: 'a chunked body',
  };

  beforeEach(() => {
    flagsMock.mockResolvedValue({ rerank: false, expandRelations: false, memoryModel: 'chunked' });
  });

  it('neither invalidates nor publishes when the live set matches', async () => {
    chunkSetMatchesMock.mockResolvedValueOnce(true);
    await indexMemory(input);
    expect(invalidateChunksMock).not.toHaveBeenCalled();
    expect(chunkAndPublishMock).not.toHaveBeenCalled();
  });

  it('invalidates and republishes when the live set does not match', async () => {
    chunkSetMatchesMock.mockResolvedValueOnce(false);
    await indexMemory(input);
    expect(invalidateChunksMock).toHaveBeenCalledTimes(1);
    expect(chunkAndPublishMock).toHaveBeenCalledTimes(1);
  });

  // cm:guard the comparison is made against the row the upsert RETURNED, never the caller's input or the pre-read: the upsert holds the parent's lock, so a set another writer replaced under this one is seen replaced here and nowhere else.
  it('compares against the text and metadata the upsert returned', async () => {
    returningMock.mockResolvedValueOnce([
      landed({ textContent: 'what actually landed', metadata: { priority: 'high' } }),
    ]);
    chunkSetMatchesMock.mockResolvedValueOnce(true);
    await indexMemory(input);
    const parent = chunkSetMatchesMock.mock.calls[0]?.[1] as { textContent: string };
    expect(parent.textContent).toBe('what actually landed');
  });

  it('skips the chunk publish under an outage, leaving the row flat-only for the backfill', async () => {
    embedMock.mockRejectedValueOnce(new FakeEmbeddingUnavailableError('down'));
    chunkSetMatchesMock.mockResolvedValueOnce(false);
    const result = await indexMemory(input);
    expect(result.degraded).toBe(true);
    expect(invalidateChunksMock).toHaveBeenCalledTimes(1);
    expect(chunkAndPublishMock).not.toHaveBeenCalled();
  });
});

// cm:guard the skip's swap and the outage's preserve are ONE clause, and this is what says so: the integration suite proves that clause's two branches against real Postgres through the outage path, and this equality is what carries the proof across to the skip. Emit a different clause for the skip and that proof silently stops covering it.
describe('the skip sends the same preserve clause the outage path does', () => {
  const dialect = new PgDialect();
  const clauseOf = (n: number) => dialect.sqlToQuery(conflictSet(n).embedding as SQL).sql;

  const input = {
    projectId: PROJECT_ID,
    source: 'note' as const,
    sourceRef: 'n-clause',
    text: 'unchanged text',
  };

  it('emits the same embedding clause on a skip as on an outage, and a bare one otherwise', async () => {
    selectLimitMock.mockResolvedValueOnce(stored(input.text));
    await indexMemory(input);
    const onSkip = clauseOf(0);

    conflictMock.mockClear();
    embedMock.mockRejectedValueOnce(new FakeEmbeddingUnavailableError('down'));
    await indexMemory({ ...input, sourceRef: 'n-clause-2' });
    const onOutage = clauseOf(0);

    conflictMock.mockClear();
    await indexMemory({ ...input, sourceRef: 'n-clause-3' });
    const onWrite = clauseOf(0);

    expect(onSkip).toBe(onOutage);
    expect(onSkip).toContain('excluded.text_content');
    expect(onSkip).toContain('CASE WHEN');
    expect(onWrite).toBe('excluded.embedding');
  });
});
