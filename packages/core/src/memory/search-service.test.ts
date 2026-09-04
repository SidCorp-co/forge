import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../config/env.js', () => ({ env: { EMBEDDINGS_MODEL: 'test-embed' } }));

const insertValues = vi.fn(() => Promise.resolve());
vi.mock('../db/client.js', () => ({
  db: { insert: vi.fn(() => ({ values: insertValues })) },
}));

vi.mock('../embeddings/index.js', () => ({
  embed: vi.fn(async () => [0.1, 0.2]),
  EmbeddingUnavailableError: class EmbeddingUnavailableError extends Error {},
}));

const hit = (id: string) => ({
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
vi.mock('./search.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./search.js')>();
  return {
    ...actual,
    searchMemories,
    keywordSearchMemories,
    hybridSearchMemories: async (input: Parameters<typeof actual.hybridSearchMemories>[0]) => {
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

function loggedMetadata(): Record<string, unknown> {
  const call = insertValues.mock.calls.at(-1) as unknown as [{ metadata: Record<string, unknown> }];
  return call[0].metadata;
}

beforeEach(() => {
  insertValues.mockClear();
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
});

describe('runMemorySearch → retrieval_analytics.metadata', () => {
  it('hybrid logs the sizes of both lists and their overlap', async () => {
    await runMemorySearch({ projectId: PROJECT, query: 'q', strategy: 'hybrid' });
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
    await runMemorySearch({ projectId: PROJECT, query: 'q', strategy: 'semantic' });
    await flushMicrotasks();
    expect(loggedMetadata()).toEqual({ strategy: 'semantic', requestedStrategy: 'semantic' });
  });

  it('keyword logs only the strategy pair', async () => {
    await runMemorySearch({ projectId: PROJECT, query: 'q', strategy: 'keyword' });
    await flushMicrotasks();
    expect(loggedMetadata()).toEqual({ strategy: 'keyword', requestedStrategy: 'keyword' });
  });
});
