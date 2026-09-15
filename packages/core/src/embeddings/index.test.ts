/**
 * ISS-1041 — the query-vector cache behind `embedQuery()`: one request per
 * text per TTL, bounded, and never filled from a fallback-model result.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../config/env.js', () => ({
  env: {
    EMBEDDINGS_BASE_URL: 'https://embed.test',
    EMBEDDINGS_API_KEY: 'k',
    EMBEDDINGS_MODEL: 'primary',
    EMBEDDINGS_DIM: 1,
    EMBEDDINGS_TIMEOUT_MS: 1000,
  },
}));

const { embedQuery, QUERY_CACHE_MAX, QUERY_CACHE_TTL_MS, queryCacheSize, resetEmbeddingsClient } =
  await import('./index.js');

let model = 'primary';
const embedDetailed = vi.fn(async (texts: string[]) => ({
  vectors: texts.map((t) => [t.length]),
  model,
}));
const client = {
  embedDetailed,
  embed: async (t: string) => (await embedDetailed([t])).vectors[0] as number[],
  embedBatch: async (ts: string[]) => (await embedDetailed(ts)).vectors,
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-15T12:00:00Z'));
  model = 'primary';
  embedDetailed.mockClear();
  resetEmbeddingsClient(client);
});
afterEach(() => {
  vi.useRealTimers();
  resetEmbeddingsClient();
});

describe('embedQuery() and its cache', () => {
  it('makes one request for the same text asked twice within the TTL (criterion 1)', async () => {
    const a = await embedQuery('what broke');
    const b = await embedQuery('what broke');
    expect(embedDetailed).toHaveBeenCalledTimes(1);
    expect(b).toEqual(a);
  });

  it('makes a second request for a different text (criterion 2)', async () => {
    await embedQuery('what broke');
    await embedQuery('who fixed it');
    expect(embedDetailed).toHaveBeenCalledTimes(2);
  });

  it('makes a fresh request once the entry is older than the TTL (criterion 3)', async () => {
    await embedQuery('what broke');
    vi.advanceTimersByTime(QUERY_CACHE_TTL_MS + 1);
    await embedQuery('what broke');
    expect(embedDetailed).toHaveBeenCalledTimes(2);
  });

  it('holds at most QUERY_CACHE_MAX entries (criterion 4)', async () => {
    for (let i = 0; i < QUERY_CACHE_MAX + 10; i++) await embedQuery(`text ${i}`);
    expect(queryCacheSize()).toBe(QUERY_CACHE_MAX);
  });

  // cm:guard recency is insertion order and a hit re-inserts: the entry evicted is the one not asked for longest, not the one inserted first.
  it('evicts the least recently used entry when full (criterion 5)', async () => {
    for (let i = 0; i < QUERY_CACHE_MAX; i++) await embedQuery(`text ${i}`);
    await embedQuery('text 0'); // a hit — text 0 is now the most recent
    embedDetailed.mockClear();
    await embedQuery('one more'); // evicts text 1, the least recently used
    await embedQuery('text 0');
    await embedQuery('text 1');
    expect(embedDetailed.mock.calls.map((c) => c[0][0])).toEqual(['one more', 'text 1']);
  });

  it('does not cache a vector the fallback model produced (criterion 6)', async () => {
    model = 'fallback';
    await embedQuery('what broke');
    model = 'primary';
    await embedQuery('what broke');
    expect(embedDetailed).toHaveBeenCalledTimes(2);
    await embedQuery('what broke');
    expect(embedDetailed).toHaveBeenCalledTimes(2);
  });
});
