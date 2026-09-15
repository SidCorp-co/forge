import { env } from '../config/env.js';
import { type EmbedDetailed, EmbeddingsClient, EmbeddingUnavailableError } from './client.js';

/** What `embed` needs of a client; the real one and a test's stand-in both fit. */
export interface EmbeddingsPort {
  embed(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
  /** Absent on a test stand-in; `embedQuery` then reads the vector off `embed` and takes the configured model as its producer. */
  embedDetailed?(texts: string[]): Promise<EmbedDetailed>;
}

let singleton: EmbeddingsPort | null = null;

function get(): EmbeddingsPort {
  if (!singleton) {
    if (!env.EMBEDDINGS_BASE_URL || !env.EMBEDDINGS_API_KEY) {
      throw new EmbeddingUnavailableError('EMBEDDINGS_BASE_URL and EMBEDDINGS_API_KEY must be set');
    }
    singleton = new EmbeddingsClient({
      baseUrl: env.EMBEDDINGS_BASE_URL,
      apiKey: env.EMBEDDINGS_API_KEY,
      model: env.EMBEDDINGS_MODEL,
      fallbackModel: env.EMBEDDINGS_FALLBACK_MODEL,
      timeoutMs: env.EMBEDDINGS_TIMEOUT_MS,
      expectedDim: env.EMBEDDINGS_DIM,
    });
  }
  return singleton;
}

export const QUERY_CACHE_MAX = 256;
export const QUERY_CACHE_TTL_MS = 10 * 60_000;

// cm:guard a bounded LRU keyed by the CONFIGURED model and the text, filled only from a result the primary model produced, and in front of the QUERY path alone: the embedding service on beta answers in 0.7 s or 11 s for the same text, and a retried or repeated search paid that twice; a fallback vector is never stored under the primary's key, so the primary's recovery is not hidden behind a cached stand-in (ISS-1041 criteria 1-6). The write path (`embed`, `embedBatch`) stays uncached: the indexer's identical-text skip is measured by counting the client's calls, and a cache there would alias what those measurements mean while holding vectors nobody asks for twice. Insertion order is recency: a hit is re-set to the end, and the first key is the eviction.
const queryCache = new Map<string, { vec: number[]; at: number }>();

/** The write path: one request per call, nothing remembered. */
export async function embed(text: string): Promise<number[]> {
  return get().embed(text);
}

/** The query path: a text asked twice within the TTL costs one request. */
export async function embedQuery(text: string): Promise<number[]> {
  const client = get();
  const key = `${env.EMBEDDINGS_MODEL}\u0000${text}`;
  const hit = queryCache.get(key);
  const now = Date.now();
  if (hit && now - hit.at < QUERY_CACHE_TTL_MS) {
    queryCache.delete(key);
    queryCache.set(key, hit);
    return hit.vec;
  }
  if (hit) queryCache.delete(key);
  const { vectors, model } = client.embedDetailed
    ? await client.embedDetailed([text])
    : { vectors: [await client.embed(text)], model: env.EMBEDDINGS_MODEL };
  const vec = vectors[0];
  if (!vec) throw new Error('embeddings: empty result');
  if (model === env.EMBEDDINGS_MODEL) {
    queryCache.set(key, { vec, at: now });
    if (queryCache.size > QUERY_CACHE_MAX) {
      const oldest = queryCache.keys().next().value;
      if (oldest !== undefined) queryCache.delete(oldest);
    }
  }
  return vec;
}

export async function embedBatch(texts: string[]): Promise<number[][]> {
  return get().embedBatch(texts);
}

/** Test-only. */
export function resetEmbeddingsClient(client?: EmbeddingsPort): void {
  singleton = client ?? null;
  queryCache.clear();
}

/** Test-only: how many query vectors the cache holds. */
export function queryCacheSize(): number {
  return queryCache.size;
}

export { EMBEDDING_UNAVAILABLE, EmbeddingsClient, EmbeddingUnavailableError } from './client.js';
