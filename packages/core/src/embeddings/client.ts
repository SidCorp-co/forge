import { logger } from '../logger.js';

/**
 * LiteLLM-compatible embeddings client with timeout, bounded retry, and a
 * module-local circuit breaker.
 *
 * Protocol: `POST {baseUrl}/embeddings` with `{ input, model }` and
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
    if (texts.length === 0) return [];
    this.assertBreakerClosed();

    try {
      return await this.embedWith(texts, this.cfg.model);
    } catch (err) {
      if (err instanceof EmbeddingUnavailableError) throw err;
      if (this.cfg.fallbackModel && !isRetriable(err)) {
        logger.warn(
          { err: (err as Error).message, fallback: this.cfg.fallbackModel },
          'embeddings: primary failed, trying fallback',
        );
        try {
          return await this.embedWith(texts, this.cfg.fallbackModel);
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
    throw lastErr ?? new Error('embeddings: exhausted retries');
  }

  private async callOnce(texts: string[], model: string): Promise<number[][]> {
    const url = new URL('embeddings', ensureTrailingSlash(this.cfg.baseUrl)).toString();

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function ensureTrailingSlash(u: string): string {
  return u.endsWith('/') ? u : `${u}/`;
}
