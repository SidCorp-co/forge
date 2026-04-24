import { env } from '../config/env.js';
import { EmbeddingUnavailableError, EmbeddingsClient } from './client.js';

let singleton: EmbeddingsClient | null = null;

function get(): EmbeddingsClient {
  if (!singleton) {
    if (!env.EMBEDDINGS_BASE_URL || !env.EMBEDDINGS_API_KEY) {
      // Throw the dedicated unavailable error so routes return 503 (a missing
      // config is operationally equivalent to "service down"), not a 500.
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

export async function embed(text: string): Promise<number[]> {
  return get().embed(text);
}

export async function embedBatch(texts: string[]): Promise<number[][]> {
  return get().embedBatch(texts);
}

/** Test-only. */
export function resetEmbeddingsClient(client?: EmbeddingsClient): void {
  singleton = client ?? null;
}

export { EMBEDDING_UNAVAILABLE, EmbeddingUnavailableError, EmbeddingsClient } from './client.js';
