import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MemoryHit } from './search.js';

const envState: { RERANK_MODEL?: string | undefined } = {};
vi.mock('../config/env.js', () => ({ env: envState }));
vi.mock('../logger.js', () => ({ logger: { warn: vi.fn(), info: vi.fn() } }));

const callFastModel = vi.fn(
  async (_p: string, _t: number, _o?: { model?: string }) => null as string | null,
);
vi.mock('./llm.js', () => ({
  callFastModel: (p: string, t: number, o?: { model?: string }) => callFastModel(p, t, o),
  fastModelName: () => 'fast-model',
}));

const {
  applyRerankOrder,
  parseRerankOutput,
  rerankHits,
  rerankModel,
  rerankPoolSize,
  resetRerankCache,
} = await import('./rerank.js');

const hit = (id: string, score: number): MemoryHit => ({
  id,
  source: 'note',
  sourceRef: id,
  text: `text of ${id}`,
  metadata: {},
  score,
  embeddedAt: new Date(0),
  stale: false,
});
const abc = () => [hit('a', 0.03), hit('b', 0.02), hit('c', 0.01)];

beforeEach(() => {
  callFastModel.mockReset();
  callFastModel.mockResolvedValue(null);
  resetRerankCache();
  envState.RERANK_MODEL = undefined;
});

describe('parseRerankOutput', () => {
  it('reads a JSON array of 1-based numbers into 0-based positions', () => {
    expect(parseRerankOutput('[3,1,2]', 3)).toEqual([2, 0, 1]);
    expect(parseRerankOutput('Sure, here you go: [2, 1]', 3)).toEqual([1, 0]);
    expect(parseRerankOutput('[]', 3)).toEqual([]);
  });
  it('refuses prose, an index out of range and a repeated index', () => {
    expect(parseRerankOutput('The most relevant passage is the third one.', 3)).toBeNull();
    expect(parseRerankOutput('[9]', 3)).toBeNull();
    expect(parseRerankOutput('[0, 1]', 3)).toBeNull();
    expect(parseRerankOutput('[1, 1, 2]', 3)).toBeNull();
  });
});

describe('applyRerankOrder', () => {
  it('places ranked candidates first and every omitted one after, in its original order', () => {
    expect(applyRerankOrder(['a', 'b', 'c', 'd'], [2])).toEqual(['c', 'a', 'b', 'd']);
    expect(applyRerankOrder(['a', 'b', 'c'], [2, 0, 1])).toEqual(['c', 'a', 'b']);
  });
});

describe('rerankHits', () => {
  it('follows the permutation the model returns and numbers the positions', async () => {
    callFastModel.mockResolvedValue('[3,1,2]');
    const r = await rerankHits({ query: 'q', hits: abc(), topK: 3 });
    expect(r.reranked).toBe(true);
    expect(r.hits.map((h) => h.id)).toEqual(['c', 'a', 'b']);
    expect(r.hits.map((h) => h.rerankPosition)).toEqual([0, 1, 2]);
    expect(r.hits.map((h) => h.score)).toEqual([0.01, 0.03, 0.02]);
    expect(r.rerankMs).toBeGreaterThanOrEqual(0);
  });

  it.each([
    ['prose', 'The first passage answers it best.'],
    ['an out-of-range index', '[9]'],
    ['a transport failure', null],
  ])('keeps RRF order cut to topK when the model returns %s, and never throws', async (_, raw) => {
    callFastModel.mockResolvedValue(raw);
    const r = await rerankHits({ query: 'q', hits: abc(), topK: 2 });
    expect(r.reranked).toBe(false);
    expect(r.hits.map((h) => h.id)).toEqual(['a', 'b']);
    expect(r.hits[0]).not.toHaveProperty('rerankPosition');
  });

  it('appends a candidate the model omitted after the ranked ones, never drops it', async () => {
    callFastModel.mockResolvedValue('[2]');
    const r = await rerankHits({ query: 'q', hits: abc(), topK: 3 });
    expect(r.hits.map((h) => h.id)).toEqual(['b', 'a', 'c']);
  });

  it('applies topK after ranking every candidate in one call', async () => {
    callFastModel.mockResolvedValue('[3,2,1]');
    const r = await rerankHits({ query: 'q', hits: abc(), topK: 1 });
    expect(callFastModel).toHaveBeenCalledTimes(1);
    expect(callFastModel.mock.calls[0]?.[0]).toContain('[3]\ntext of c');
    expect(r.hits.map((h) => h.id)).toEqual(['c']);
  });

  it('makes no call for a single candidate', async () => {
    const r = await rerankHits({ query: 'q', hits: [hit('a', 1)], topK: 5 });
    expect(callFastModel).not.toHaveBeenCalled();
    expect(r.reranked).toBe(false);
  });

  it('reuses one ordering for the identical query, ids in order and texts; a reordered set is a new call', async () => {
    callFastModel.mockResolvedValue('[2,1,3]');
    await rerankHits({ query: 'q', hits: abc(), topK: 3 });
    const again = await rerankHits({ query: 'q', hits: abc(), topK: 2 });
    expect(callFastModel).toHaveBeenCalledTimes(1);
    expect(again.hits.map((h) => h.id)).toEqual(['b', 'a']);

    await rerankHits({ query: 'q', hits: abc().reverse(), topK: 3 });
    expect(callFastModel).toHaveBeenCalledTimes(2);

    const changed = [{ ...hit('a', 0.03), text: 'rewritten' }, hit('b', 0.02), hit('c', 0.01)];
    await rerankHits({ query: 'q', hits: changed, topK: 3 });
    expect(callFastModel).toHaveBeenCalledTimes(3);
  });

  it('names RERANK_MODEL when set and the fast model otherwise', async () => {
    callFastModel.mockResolvedValue('[1,2,3]');
    await rerankHits({ query: 'q', hits: abc(), topK: 3 });
    expect(callFastModel.mock.calls[0]?.[2]).toEqual({ model: 'fast-model' });
    expect(rerankModel()).toBe('fast-model');

    envState.RERANK_MODEL = 'rr-model';
    resetRerankCache();
    await rerankHits({ query: 'q', hits: abc(), topK: 3 });
    expect(callFastModel.mock.calls[1]?.[2]).toEqual({ model: 'rr-model' });
  });
});

describe('rerankPoolSize', () => {
  it('is three times topK, capped at 50', () => {
    expect(rerankPoolSize(10)).toBe(30);
    expect(rerankPoolSize(20)).toBe(50);
    expect(rerankPoolSize(1)).toBe(3);
  });
});
