import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MemoryHit } from './search.js';

vi.mock('../config/env.js', () => ({ env: { EMBEDDINGS_MODEL: 'test-embed' } }));

const insertValues = vi.fn(() => Promise.resolve());
vi.mock('../db/client.js', () => ({
  db: { insert: vi.fn(() => ({ values: insertValues })) },
}));

vi.mock('../embeddings/index.js', () => ({
  embed: vi.fn(async () => [0.1, 0.2]),
  EmbeddingUnavailableError: class EmbeddingUnavailableError extends Error {},
}));

const flags = { rerank: false, expandRelations: false };
vi.mock('./retrieval-flags.js', () => ({
  loadRetrievalFlags: vi.fn(async () => ({ ...flags })),
}));

const fastConfigured = vi.fn(() => true);
vi.mock('./llm.js', () => ({ fastModelConfigured: () => fastConfigured() }));

const holdout = vi.fn(() => false);
type RerankOut = { hits: MemoryHit[]; reranked: boolean; rerankMs: number };
const rerankHitsMock = vi.fn(
  async (input: { hits: MemoryHit[]; topK: number }): Promise<RerankOut> => ({
    hits: [...input.hits]
      .reverse()
      .slice(0, input.topK)
      .map((h, i) => ({ ...h, rerankPosition: i })),
    reranked: true,
    rerankMs: 7,
  }),
);
vi.mock('./rerank.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./rerank.js')>();
  return {
    ...actual,
    inRerankHoldout: () => holdout(),
    rerankHits: (input: { query: string; hits: MemoryHit[]; topK: number }) =>
      rerankHitsMock(input),
  };
});

const expandMock = vi.fn(
  async (_input: { hits: MemoryHit[]; topK: number }): Promise<MemoryHit[]> => [],
);
vi.mock('./expand-relations.js', () => ({
  expandIssueRelations: (input: { hits: MemoryHit[]; topK: number }) => expandMock(input),
}));

const hit = (id: string): MemoryHit => ({
  id,
  source: 'note' as const,
  sourceRef: id,
  text: id,
  metadata: {},
  score: 0.5,
  embeddedAt: new Date(0),
  stale: false,
});

const searchMemories = vi.fn(async () => [hit('a'), hit('b')]);
const keywordSearchMemories = vi.fn(async () => [hit('b'), hit('c'), hit('d')]);
const hybridTopK = vi.fn((_topK: number | undefined) => undefined);
vi.mock('./search.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./search.js')>();
  return {
    ...actual,
    searchMemories,
    keywordSearchMemories,
    hybridSearchMemories: async (input: Parameters<typeof actual.hybridSearchMemories>[0]) => {
      hybridTopK(input.topK);
      const [semantic, keyword] = await Promise.all([searchMemories(), keywordSearchMemories()]);
      const keywordIds = new Set(keyword.map((h) => h.id));
      return {
        hits: actual.reciprocalRankFusion([semantic, keyword], [0.7, 0.3], input.topK ?? 10),
        breakdown: {
          semanticHits: semantic.length,
          keywordHits: keyword.length,
          overlap: semantic.filter((h) => keywordIds.has(h.id)).length,
        },
      };
    },
    touchMemories: vi.fn(async () => undefined),
  };
});

const { buildRetrievalMetadata, runMemorySearch } = await import('./search-service.js');

const PROJECT = '11111111-1111-4111-8111-111111111111';
const flushMicrotasks = () => new Promise((r) => setTimeout(r, 0));
const RRF_ORDER = ['b', 'a', 'c', 'd'];

function loggedMetadata(): Record<string, unknown> {
  const call = insertValues.mock.calls.at(-1) as unknown as [{ metadata: Record<string, unknown> }];
  return call[0].metadata;
}

const agentHybrid = (topK?: number) =>
  runMemorySearch({ projectId: PROJECT, query: 'q', strategy: 'hybrid', surface: 'agent', topK });

beforeEach(() => {
  insertValues.mockClear();
  rerankHitsMock.mockClear();
  expandMock.mockClear();
  hybridTopK.mockClear();
  flags.rerank = false;
  flags.expandRelations = false;
  fastConfigured.mockReturnValue(true);
  holdout.mockReturnValue(false);
});

describe('buildRetrievalMetadata', () => {
  it('carries the strategy pair and, when given, the three breakdown counts', () => {
    expect(
      buildRetrievalMetadata('hybrid', 'hybrid', { semanticHits: 2, keywordHits: 3, overlap: 1 }),
    ).toEqual({
      strategy: 'hybrid',
      requestedStrategy: 'hybrid',
      semanticHits: 2,
      keywordHits: 3,
      overlap: 1,
    });
  });
  it('writes no breakdown key at all when there is no breakdown', () => {
    expect(Object.keys(buildRetrievalMetadata('semantic', 'semantic', undefined))).toEqual([
      'strategy',
      'requestedStrategy',
    ]);
  });
  it('writes an outcome key only when it is true, and hitIds only when given', () => {
    expect(
      buildRetrievalMetadata('hybrid', 'hybrid', undefined, {
        reranked: false,
        expanded: false,
      }),
    ).toEqual({ strategy: 'hybrid', requestedStrategy: 'hybrid' });
    expect(
      buildRetrievalMetadata('hybrid', 'hybrid', undefined, {
        reranked: true,
        rerankMs: 12,
        rerankHoldout: true,
        expanded: true,
        expandedCount: 2,
        hitIds: ['x'],
      }),
    ).toEqual({
      strategy: 'hybrid',
      requestedStrategy: 'hybrid',
      reranked: true,
      rerankMs: 12,
      rerankHoldout: true,
      expanded: true,
      expandedCount: 2,
      hitIds: ['x'],
    });
  });
});

describe('runMemorySearch → retrieval_analytics.metadata', () => {
  it('hybrid logs the sizes of both lists and their overlap', async () => {
    await runMemorySearch({ projectId: PROJECT, query: 'q', strategy: 'hybrid', surface: 'web' });
    await flushMicrotasks();
    expect(loggedMetadata()).toEqual({
      strategy: 'hybrid',
      requestedStrategy: 'hybrid',
      semanticHits: 2,
      keywordHits: 3,
      overlap: 1,
    });
  });

  it('semantic logs only the strategy pair', async () => {
    await runMemorySearch({
      projectId: PROJECT,
      query: 'q',
      strategy: 'semantic',
      surface: 'agent',
    });
    await flushMicrotasks();
    expect(loggedMetadata()).toEqual({ strategy: 'semantic', requestedStrategy: 'semantic' });
  });

  it('keyword logs only the strategy pair', async () => {
    await runMemorySearch({
      projectId: PROJECT,
      query: 'q',
      strategy: 'keyword',
      surface: 'agent',
    });
    await flushMicrotasks();
    expect(loggedMetadata()).toEqual({ strategy: 'keyword', requestedStrategy: 'keyword' });
  });

  it('a hybrid agent search logs hitIds in returned order and no rerank key while the flag is off', async () => {
    const res = await agentHybrid();
    await flushMicrotasks();
    expect(res.hits.map((h) => h.id)).toEqual(RRF_ORDER);
    expect(res.reranked).toBe(false);
    expect(loggedMetadata()).toMatchObject({ hitIds: RRF_ORDER });
    expect(loggedMetadata()).not.toHaveProperty('reranked');
    expect(rerankHitsMock).not.toHaveBeenCalled();
  });
});

describe('rerank gating', () => {
  it('flag on + agent + hybrid: fuses 3 × topK, follows the reranker and says so', async () => {
    flags.rerank = true;
    const res = await agentHybrid(1);
    await flushMicrotasks();
    expect(hybridTopK).toHaveBeenCalledWith(3);
    expect(rerankHitsMock).toHaveBeenCalledWith(
      expect.objectContaining({ topK: 1, hits: expect.arrayContaining([expect.anything()]) }),
    );
    expect(res.hits.map((h) => h.id)).toEqual(['c']);
    expect(res.hits[0]?.rerankPosition).toBe(0);
    expect(res.hits[0]?.score).toBeCloseTo(0.3 / 62, 6);
    expect(res.reranked).toBe(true);
    expect(loggedMetadata()).toMatchObject({ reranked: true, rerankMs: 7, hitIds: ['c'] });
  });

  it('the web surface is never reranked, flag or not', async () => {
    flags.rerank = true;
    const res = await runMemorySearch({
      projectId: PROJECT,
      query: 'q',
      strategy: 'hybrid',
      surface: 'web',
      topK: 2,
    });
    expect(rerankHitsMock).not.toHaveBeenCalled();
    expect(hybridTopK).toHaveBeenCalledWith(2);
    expect(res.hits.map((h) => h.id)).toEqual(['b', 'a']);
    expect(res.reranked).toBe(false);
  });

  it('semantic and keyword are never reranked', async () => {
    flags.rerank = true;
    for (const strategy of ['semantic', 'keyword'] as const) {
      const res = await runMemorySearch({
        projectId: PROJECT,
        query: 'q',
        strategy,
        surface: 'agent',
      });
      expect(res.reranked).toBe(false);
    }
    expect(rerankHitsMock).not.toHaveBeenCalled();
  });

  it('no fast model configured means no rerank', async () => {
    flags.rerank = true;
    fastConfigured.mockReturnValue(false);
    const res = await agentHybrid();
    expect(rerankHitsMock).not.toHaveBeenCalled();
    expect(res.reranked).toBe(false);
  });

  it('the one-in-five holdout keeps RRF order, cuts to topK and is labelled on both sides', async () => {
    flags.rerank = true;
    holdout.mockReturnValue(true);
    const res = await agentHybrid(2);
    await flushMicrotasks();
    expect(rerankHitsMock).not.toHaveBeenCalled();
    expect(hybridTopK).toHaveBeenCalledWith(2);
    expect(res.hits.map((h) => h.id)).toEqual(['b', 'a']);
    expect(res.reranked).toBe(false);
    expect(res.rerankHoldout).toBe(true);
    expect(loggedMetadata()).toMatchObject({ rerankHoldout: true, hitIds: ['b', 'a'] });
    expect(loggedMetadata()).not.toHaveProperty('reranked');
  });

  it('a reranker that gave up leaves the response unreranked and the row without a rerank key', async () => {
    flags.rerank = true;
    rerankHitsMock.mockImplementationOnce(async (input) => ({
      hits: input.hits.slice(0, input.topK),
      reranked: false,
      rerankMs: 3,
    }));
    const res = await agentHybrid(2);
    await flushMicrotasks();
    expect(res.hits.map((h) => h.id)).toEqual(['b', 'a']);
    expect(res.reranked).toBe(false);
    expect(loggedMetadata()).not.toHaveProperty('reranked');
  });
});

describe('relation expansion', () => {
  it('flag on: appends what the expander returns after the ranked hits and says so on both sides', async () => {
    flags.expandRelations = true;
    const via = { relation: 'blocks' as const, from: 'ISS-1' };
    expandMock.mockResolvedValueOnce([{ ...hit('n'), source: 'issue', score: 0, via }]);
    const res = await runMemorySearch({
      projectId: PROJECT,
      query: 'q',
      strategy: 'semantic',
      surface: 'web',
      topK: 2,
    });
    await flushMicrotasks();
    expect(expandMock).toHaveBeenCalledWith(expect.objectContaining({ topK: 2 }));
    expect(res.hits.map((h) => h.id)).toEqual(['a', 'b', 'n']);
    expect(res.hits[2]?.via).toEqual(via);
    expect(res.expanded).toBe(true);
    expect(loggedMetadata()).toMatchObject({ expanded: true, expandedCount: 1 });
  });

  it('flag off: the expander is never consulted', async () => {
    const res = await agentHybrid();
    expect(expandMock).not.toHaveBeenCalled();
    expect(res.expanded).toBe(false);
  });

  it('an expander failure returns the ranked hits alone', async () => {
    flags.expandRelations = true;
    expandMock.mockRejectedValueOnce(new Error('edges down'));
    const res = await agentHybrid();
    expect(res.hits.map((h) => h.id)).toEqual(RRF_ORDER);
    expect(res.expanded).toBe(false);
  });
});
