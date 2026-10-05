import { createOpenAICompatible, type OpenAICompatibleProvider } from '@ai-sdk/openai-compatible';
import { APICallError, embedMany, RetryError } from 'ai';
import { logger } from '../../lib/logger.js';
import { openAiCompatBaseUrl } from '../../lib/openai-compat-url.js';

/**
 * OpenAI-compatible embeddings client (`POST {base}/v1/embeddings`) over the AI SDK, which owns the
 * wire and the bounded retry; this module keeps the per-attempt timeout, the fallback model, the
 * quota reading, the dimension guard and a module-local circuit breaker.
 */

interface EmbeddingsConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  fallbackModel?: string | undefined;
  timeoutMs: number;
  /**
   * Optional dimension hint. Acts as BOTH:
   *   1. Request param `dimensions` in the embeddings call — providers that
   *      support Matryoshka output (OpenAI text-embedding-3, Gemini
   *      gemini-embedding-001, Voyage 3) honor it and truncate server-side.
   *   2. Runtime guard — the response embedding length is asserted to equal
   *      this value, so a misconfigured proxy that ignores `dimensions` fails
   *      fast with a clear `dimension mismatch` error instead of corrupting
   *      the pgvector column.
   */
  expectedDim?: number | undefined;
}

export const EMBEDDING_UNAVAILABLE = 'EMBEDDING_UNAVAILABLE' as const;

export class EmbeddingUnavailableError extends Error {
  code = EMBEDDING_UNAVAILABLE;
  constructor(message: string) {
    super(message);
    this.name = 'EmbeddingUnavailableError';
  }
}

interface CircuitBreakerState {
  consecutiveFailures: number;
  openUntil: number;
}

const FAILURE_THRESHOLD = 5;
const OPEN_DURATION_MS = 30_000;
const MAX_RETRIES = 2;

/** Vectors and the model that produced them — the configured one, or its fallback. */
export interface EmbedDetailed {
  vectors: number[][];
  model: string;
}

/** An attempt that outlives its timeout fails as a network error would, so the SDK retries it rather than treating it as the caller's abort. */
function timedFetch(fetchFn: typeof fetch, timeoutMs: number): typeof fetch {
  return async (input, init) => {
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    try {
      return await fetchFn(input, { ...init, signal });
    } catch (err) {
      if (timeout.aborted && !init?.signal?.aborted) {
        throw new TypeError('fetch failed', { cause: new Error(`timed out after ${timeoutMs}ms`) });
      }
      throw err;
    }
  };
}

export class EmbeddingsClient {
  private readonly cfg: EmbeddingsConfig;
  private readonly breaker: CircuitBreakerState;
  private readonly sdk: OpenAICompatibleProvider;

  constructor(cfg: EmbeddingsConfig, fetchFn: typeof fetch = fetch) {
    this.cfg = cfg;
    this.breaker = { consecutiveFailures: 0, openUntil: 0 };
    this.sdk = createOpenAICompatible({
      name: 'embeddings',
      baseURL: openAiCompatBaseUrl(cfg.baseUrl),
      apiKey: cfg.apiKey,
      fetch: timedFetch(fetchFn, cfg.timeoutMs),
    });
  }

  /** Test-only. Reset the in-memory circuit breaker state. */
  resetBreaker(): void {
    this.breaker.consecutiveFailures = 0;
    this.breaker.openUntil = 0;
  }

  async embed(text: string): Promise<number[]> {
    const [vec] = await this.embedBatch([text]);
    if (!vec) throw new Error('embeddings: empty result');
    return vec;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    return (await this.embedDetailed(texts)).vectors;
  }

  async embedDetailed(texts: string[]): Promise<EmbedDetailed> {
    if (texts.length === 0) return { vectors: [], model: this.cfg.model };
    this.assertBreakerClosed();
    try {
      return { vectors: await this.embedWith(texts, this.cfg.model), model: this.cfg.model };
    } catch (err) {
      if (err instanceof EmbeddingUnavailableError || !this.cfg.fallbackModel) {
        this.recordFailure();
        throw err;
      }
      logger.warn(
        { err: (err as Error).message, fallback: this.cfg.fallbackModel },
        'embeddings: primary failed, trying fallback',
      );
      try {
        return {
          vectors: await this.embedWith(texts, this.cfg.fallbackModel),
          model: this.cfg.fallbackModel,
        };
      } catch (fallbackErr) {
        this.recordFailure();
        throw fallbackErr;
      }
    }
  }

  private assertBreakerClosed(): void {
    if (this.breaker.openUntil > Date.now()) {
      throw new EmbeddingUnavailableError(
        `embeddings service unavailable (breaker open until ${new Date(this.breaker.openUntil).toISOString()})`,
      );
    }
  }

  private recordFailure(): void {
    this.breaker.consecutiveFailures += 1;
    if (this.breaker.consecutiveFailures >= FAILURE_THRESHOLD) {
      this.breaker.openUntil = Date.now() + OPEN_DURATION_MS;
      logger.error(
        { threshold: FAILURE_THRESHOLD, openForMs: OPEN_DURATION_MS },
        'embeddings: circuit breaker opened',
      );
    }
  }

  private recordSuccess(): void {
    this.breaker.consecutiveFailures = 0;
    this.breaker.openUntil = 0;
  }

  private async embedWith(texts: string[], model: string): Promise<number[][]> {
    let vectors: number[][];
    try {
      ({ embeddings: vectors } = await embedMany({
        model: this.sdk.embeddingModel(model),
        values: texts,
        maxRetries: MAX_RETRIES,
        // Request server-side dimensionality reduction (Matryoshka); a proxy that ignores it is
        // caught by the `expectedDim` length check below.
        ...(this.cfg.expectedDim !== undefined
          ? { providerOptions: { embeddings: { dimensions: this.cfg.expectedDim } } }
          : {}),
      }));
    } catch (err) {
      throw classify(err);
    }
    if (vectors.some((v) => !Array.isArray(v) || v.length === 0)) {
      throw new Error('embeddings: malformed response (missing embedding[])');
    }
    if (this.cfg.expectedDim !== undefined) {
      for (const v of vectors) {
        if (v.length !== this.cfg.expectedDim) {
          throw new Error(
            `embeddings: dimension mismatch (got ${v.length}, expected ${this.cfg.expectedDim}) — check EMBEDDINGS_MODEL vs EMBEDDINGS_DIM`,
          );
        }
      }
    }
    this.recordSuccess();
    return vectors;
  }
}

function classify(err: unknown): Error {
  const exhausted = RetryError.isInstance(err) && err.reason === 'maxRetriesExceeded';
  const cause = RetryError.isInstance(err) ? err.lastError : err;
  const call = APICallError.isInstance(cause) ? cause : null;
  const body = (call?.responseBody ?? '').slice(0, 200);
  if (
    call?.statusCode !== undefined &&
    isQuotaRejection(call.statusCode, call.responseBody ?? '')
  ) {
    return new EmbeddingUnavailableError(
      `embeddings quota exhausted (${call.statusCode}): ${body}`,
    );
  }
  const message = cause instanceof Error ? cause.message : String(cause);
  if (exhausted || call?.isRetryable) {
    return new EmbeddingUnavailableError(
      `embeddings service unavailable after ${MAX_RETRIES + 1} attempts: ${call?.statusCode ?? ''} ${body || message}`.trim(),
    );
  }
  if (call?.statusCode !== undefined) return new Error(`embeddings ${call.statusCode}: ${body}`);
  return new Error(`embeddings: ${message}`);
}

const QUOTA_MARKERS = [
  'budget has been exceeded',
  'budget exceeded',
  'quota',
  'insufficient_quota',
  'rate limit',
  'billing',
] as const;

function isQuotaRejection(status: number, body: string): boolean {
  if (status === 429) return true;
  const haystack = body.toLowerCase();
  return QUOTA_MARKERS.some((m) => haystack.includes(m));
}
