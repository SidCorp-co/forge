import { openAiCompatUrl } from '../lib/openai-compat-url.js';
import { logger } from '../logger.js';

/**
 * LiteLLM-compatible embeddings client with timeout, bounded retry, and a
 * module-local circuit breaker.
 *
 * Protocol: `POST {baseUrl}/v1/embeddings` (base is the host; a trailing `/v1` is tolerated) with `{ input, model }` and
 * `Authorization: Bearer <apiKey>`. Response follows the OpenAI shape
 * `{ data: [{ embedding: number[] }, ...] }`.
 */

export interface EmbeddingsConfig {
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

export interface CircuitBreakerState {
  consecutiveFailures: number;
  openUntil: number;
}

const FAILURE_THRESHOLD = 5;
const OPEN_DURATION_MS = 30_000;
const RETRY_DELAYS_MS = [250, 1_000, 4_000];

/** Vectors and the model that produced them — the configured one, or its fallback. */
export interface EmbedDetailed {
  vectors: number[][];
  model: string;
}

/** Vectors and the model that produced them — the configured one, or its fallback. */
export interface EmbedDetailed {
  vectors: number[][];
  model: string;
}

/** Vectors and the model that produced them — the configured one, or its fallback. */
export interface EmbedDetailed {
  vectors: number[][];
  model: string;
}

export class EmbeddingsClient {
  private readonly cfg: EmbeddingsConfig;
  private readonly breaker: CircuitBreakerState;
  private readonly fetchFn: typeof fetch;

  constructor(cfg: EmbeddingsConfig, fetchFn: typeof fetch = fetch) {
    this.cfg = cfg;
    this.breaker = { consecutiveFailures: 0, openUntil: 0 };
    this.fetchFn = fetchFn;
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

  // cm:guard the model that PRODUCED the vectors rides beside them, because this is the one place the fallback is chosen: a caller caching by the configured model would otherwise keep serving a fallback vector after the primary recovers (ISS-1041 criterion 6).
  async embedDetailed(texts: string[]): Promise<EmbedDetailed> {
    if (texts.length === 0) return { vectors: [], model: this.cfg.model };
    this.assertBreakerClosed();

    try {
      return { vectors: await this.embedWith(texts, this.cfg.model), model: this.cfg.model };
    } catch (err) {
      if (err instanceof EmbeddingUnavailableError) throw err;
      if (this.cfg.fallbackModel && !isRetriable(err)) {
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
      this.recordFailure();
      throw err;
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
        {
          threshold: FAILURE_THRESHOLD,
          openForMs: OPEN_DURATION_MS,
        },
        'embeddings: circuit breaker opened',
      );
    }
  }

  private recordSuccess(): void {
    this.breaker.consecutiveFailures = 0;
    this.breaker.openUntil = 0;
  }

  private async embedWith(texts: string[], model: string): Promise<number[][]> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < RETRY_DELAYS_MS.length + 1; attempt++) {
      try {
        const result = await this.callOnce(texts, model);
        this.recordSuccess();
        return result;
      } catch (err) {
        lastErr = err;
        if (!isRetriable(err)) throw err;
        const delay = RETRY_DELAYS_MS[attempt];
        if (delay === undefined) break;
        logger.warn(
          { attempt: attempt + 1, delay, err: (err as Error).message },
          'embeddings: retrying',
        );
        await sleep(delay);
      }
    }
    // cm:guard exhausted retries are UNAVAILABILITY and must classify as it. `callOnce` wraps a
    // network failure as `RetriableError`; rethrowing that raw meant the plainest outage there is —
    // a host that does not resolve — never reached the degraded paths, which key on
    // `EmbeddingUnavailableError`. `upsertKnowledgeEntries` would then fail the caller's write
    // instead of storing the row with a null vector for the backfill to find, and memory would lose
    // the keyword-searchable row it stores for the same reason. Degradation only began once the
    // breaker opened after five consecutive failures, so whether a save survived an outage depended
    // on how many saves had already failed ahead of it. ISS-1048 reached this from
    // `recompileAndPersistUxContract`, which an operator drives from a button.
    if (isRetriable(lastErr)) {
      throw new EmbeddingUnavailableError(
        `embeddings service unavailable after ${RETRY_DELAYS_MS.length + 1} attempts: ${(lastErr as Error).message}`,
      );
    }
    throw lastErr ?? new Error('embeddings: exhausted retries');
  }

  private async callOnce(texts: string[], model: string): Promise<number[][]> {
    const url = openAiCompatUrl(this.cfg.baseUrl, 'embeddings');

    const body: Record<string, unknown> = {
      input: texts.length === 1 ? texts[0] : texts,
      model,
    };
    // Request server-side dimensionality reduction (Matryoshka) for providers
    // that need it. When the proxy ignores this field, the `expectedDim`
    // length check below catches the mismatch and surfaces it explicitly.
    if (this.cfg.expectedDim !== undefined) {
      body.dimensions = this.cfg.expectedDim;
    }

    let response: Response;
    try {
      response = await this.fetchFn(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.cfg.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.cfg.timeoutMs),
      });
    } catch (err) {
      throw new RetriableError(`network error: ${(err as Error).message}`, err);
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      if (response.status >= 500) {
        throw new RetriableError(`${response.status} ${body.slice(0, 200)}`);
      }
      // cm:guard a budget/quota rejection MUST classify as unavailable, not as a hard error — callers degrade gracefully on EmbeddingUnavailableError (memory stores a keyword-searchable row for backfill) but propagate anything else, and that difference is a whole session's learning silently lost
      if (isQuotaRejection(response.status, body)) {
        throw new EmbeddingUnavailableError(
          `embeddings quota exhausted (${response.status}): ${body.slice(0, 200)}`,
        );
      }
      throw new Error(`embeddings ${response.status}: ${body.slice(0, 200)}`);
    }

    const payload = (await response.json()) as {
      data?: Array<{ embedding?: number[] }>;
    };
    if (!payload.data || !Array.isArray(payload.data)) {
      throw new Error('embeddings: malformed response (missing data[])');
    }
    const vectors = payload.data.map((d) => d.embedding ?? []);
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
    return vectors as number[][];
  }
}

class RetriableError extends Error {
  readonly retriable = true as const;
  constructor(message: string, cause?: unknown) {
    super(message, cause ? { cause } : undefined);
    this.name = 'RetriableError';
  }
}

function isRetriable(err: unknown): boolean {
  return err instanceof RetriableError;
}

// cm:why matched on body text and not status alone — providers signal an exhausted budget as 400/402/403 as readily as 429, and the case that actually cost us a learning was a 400 reading "Budget has been exceeded"
const QUOTA_MARKERS = [
  'budget has been exceeded',
  'budget exceeded',
  'quota',
  'insufficient_quota',
  'rate limit',
  'billing',
] as const;

export function isQuotaRejection(status: number, body: string): boolean {
  if (status === 429) return true;
  const haystack = body.toLowerCase();
  return QUOTA_MARKERS.some((m) => haystack.includes(m));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
