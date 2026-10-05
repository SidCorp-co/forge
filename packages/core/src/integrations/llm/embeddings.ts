import { EgressRefused, type EgressScope, egressScoped } from '../../lib/data-egress.js';
import { env } from '../../lib/env.js';
import {
  type EmbedDetailed,
  EmbeddingsClient,
  EmbeddingUnavailableError,
} from './embeddings-client.js';

/** What `embed` needs of a client; the real one and a test's stand-in both fit. */
interface EmbeddingsPort {
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

const QUERY_CACHE_MAX = 256;
const QUERY_CACHE_TTL_MS = 10 * 60_000;

const queryCache = new Map<string, { vec: number[]; at: number }>();

async function sent(scope: EgressScope, text: string): Promise<string> {
  const out = await egressScoped(scope, text);
  if (!out.ok) throw new EgressRefused(out.refusal);
  return out.text;
}

/** The write path: one request per call, nothing remembered. */
export async function embed(scope: EgressScope, text: string): Promise<number[]> {
  return get().embed(await sent(scope, text));
}

/** The query path: a text asked twice within the TTL costs one request. */
export async function embedQuery(scope: EgressScope, asked: string): Promise<number[]> {
  const client = get();
  const text = await sent(scope, asked);
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

/** Whether a provider is configured at all; false means every write reports it, never skips silently. */
export function embeddingsConfigured(): boolean {
  return singleton !== null || Boolean(env.EMBEDDINGS_BASE_URL && env.EMBEDDINGS_API_KEY);
}

/** One vector and the model that produced it — the configured one, or its fallback. */
export async function embedWithModel(
  scope: EgressScope,
  asked: string,
): Promise<{ vector: number[]; model: string }> {
  const client = get();
  const text = await sent(scope, asked);
  const { vectors, model } = client.embedDetailed
    ? await client.embedDetailed([text])
    : { vectors: [await client.embed(text)], model: env.EMBEDDINGS_MODEL };
  const vector = vectors[0];
  if (!vector) throw new Error('embeddings: empty result');
  return { vector, model };
}

export async function embedBatch(scope: EgressScope, texts: string[]): Promise<number[][]> {
  const client = get();
  return client.embedBatch(await Promise.all(texts.map((t) => sent(scope, t))));
}

export { EMBEDDING_UNAVAILABLE, EmbeddingUnavailableError } from './embeddings-client.js';
