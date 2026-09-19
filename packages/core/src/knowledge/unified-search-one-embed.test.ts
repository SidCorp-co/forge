import { beforeEach, describe, expect, it, vi } from 'vitest';

class FakeOutage extends Error {}
const embedMock = vi.fn();
vi.mock('../embeddings/index.js', () => ({
  embed: (t: string) => embedMock(t),
  EmbeddingUnavailableError: FakeOutage,
}));

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const runMemorySearchMock = vi.fn();
vi.mock('../memory/search-service.js', () => ({
  runMemorySearch: (input: unknown) => runMemorySearchMock(input),
}));

const searchKnowledgeMock = vi.fn();
const hybridSearchKnowledgeMock = vi.fn();
const keywordSearchKnowledgeMock = vi.fn();
vi.mock('./search.js', () => ({
  searchKnowledge: (...a: unknown[]) => searchKnowledgeMock(...a),
  hybridSearchKnowledge: (...a: unknown[]) => hybridSearchKnowledgeMock(...a),
  keywordSearchKnowledge: (...a: unknown[]) => keywordSearchKnowledgeMock(...a),
}));

const { runUnifiedSearch } = await import('./unified-search.js');

const PROJECT = '11111111-1111-4111-8111-111111111111';
const VEC = [0.5, 0.25];

beforeEach(() => {
  embedMock.mockReset();
  runMemorySearchMock.mockReset();
  searchKnowledgeMock.mockReset();
  hybridSearchKnowledgeMock.mockReset();
  keywordSearchKnowledgeMock.mockReset();
  embedMock.mockResolvedValue(VEC);
  runMemorySearchMock.mockResolvedValue({ hits: [] });
  searchKnowledgeMock.mockResolvedValue([]);
  hybridSearchKnowledgeMock.mockResolvedValue([]);
  keywordSearchKnowledgeMock.mockResolvedValue([]);
});

describe('runUnifiedSearch', () => {
  it('embeds the query once across both stores at semantic', async () => {
    await runUnifiedSearch({ projectId: PROJECT, query: 'slot capacity', scope: 'all' });
    expect(embedMock).toHaveBeenCalledTimes(1);
  });

  it('hands the memory search the vector it already holds', async () => {
    await runUnifiedSearch({ projectId: PROJECT, query: 'slot capacity', scope: 'all' });
    expect(runMemorySearchMock.mock.calls[0]?.[0]).toMatchObject({ queryVec: VEC });
  });

  it('embeds once at hybrid too', async () => {
    await runUnifiedSearch({
      projectId: PROJECT,
      query: 'slot capacity',
      scope: 'all',
      strategy: 'hybrid',
    });
    expect(embedMock).toHaveBeenCalledTimes(1);
    expect(runMemorySearchMock.mock.calls[0]?.[0]).toMatchObject({ queryVec: VEC });
  });

  it('makes no embed call at keyword, and passes no vector down', async () => {
    await runUnifiedSearch({
      projectId: PROJECT,
      query: 'slot capacity',
      scope: 'all',
      strategy: 'keyword',
    });
    expect(embedMock).not.toHaveBeenCalled();
    expect(runMemorySearchMock.mock.calls[0]?.[0]).not.toHaveProperty('queryVec');
  });

  it('degrades to keyword on both stores when the one embed fails', async () => {
    embedMock.mockRejectedValueOnce(new FakeOutage('down'));
    const out = await runUnifiedSearch({ projectId: PROJECT, query: 'q', scope: 'all' });
    expect(out.degraded).toBe(true);
    expect(keywordSearchKnowledgeMock).toHaveBeenCalledTimes(1);
    expect(runMemorySearchMock.mock.calls[0]?.[0]).toMatchObject({ strategy: 'keyword' });
  });
});
