import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EmbeddingUnavailableError, EmbeddingsClient } from './client.js';

function mockFetchOnce(status: number, body: unknown): typeof fetch {
  return vi.fn(
    async () =>
      new Response(typeof body === 'string' ? body : JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
  ) as unknown as typeof fetch;
}

function mockFetchSequence(
  ...responses: Array<{ status: number; body: unknown } | Error>
): typeof fetch {
  let idx = 0;
  return vi.fn(async () => {
    const r = responses[idx++];
    if (!r) throw new Error('sequence exhausted');
    if (r instanceof Error) throw r;
    return new Response(typeof r.body === 'string' ? r.body : JSON.stringify(r.body), {
      status: r.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
}

const cfg = {
  baseUrl: 'https://embeddings.example',
  apiKey: 'test-key',
  model: 'text-embedding-3-small',
  timeoutMs: 5_000,
};

beforeEach(() => {
  vi.useRealTimers();
});

describe('EmbeddingsClient.embed', () => {
  it('returns the embedding on 200', async () => {
    const fetchFn = mockFetchOnce(200, { data: [{ embedding: [0.1, 0.2, 0.3] }] });
    const client = new EmbeddingsClient(cfg, fetchFn);
    const vec = await client.embed('hello');
    expect(vec).toEqual([0.1, 0.2, 0.3]);
  });

  it('sends `dimensions` in the request body when expectedDim is configured (Matryoshka truncate)', async () => {
    const calls: Array<{ url: unknown; init: RequestInit | undefined }> = [];
    const fetchFn = vi.fn(async (url: unknown, init?: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ data: [{ embedding: new Array(1536).fill(0.01) }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    const client = new EmbeddingsClient({ ...cfg, expectedDim: 1536 }, fetchFn);
    await client.embed('hi');

    const body = JSON.parse(calls[0]?.init?.body as string) as Record<string, unknown>;
    expect(body.dimensions).toBe(1536);
    expect(body.input).toBe('hi');
    expect(body.model).toBe('text-embedding-3-small');
  });

  it('omits `dimensions` from the request body when expectedDim is undefined', async () => {
    const calls: Array<{ url: unknown; init: RequestInit | undefined }> = [];
    const fetchFn = vi.fn(async (url: unknown, init?: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2] }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    const client = new EmbeddingsClient(cfg, fetchFn);
    await client.embed('hi');

    const body = JSON.parse(calls[0]?.init?.body as string) as Record<string, unknown>;
    expect('dimensions' in body).toBe(false);
  });

  it('retries on 5xx up to 3 retries and succeeds', async () => {
    const fetchFn = mockFetchSequence(
      { status: 502, body: 'bad gateway' },
      { status: 503, body: 'still' },
      { status: 200, body: { data: [{ embedding: [1, 2] }] } },
    );
    const client = new EmbeddingsClient(cfg, fetchFn);
    const vec = await client.embed('hi');
    expect(vec).toEqual([1, 2]);
    expect((fetchFn as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(3);
  }, 15_000);

  it('does NOT retry on 4xx', async () => {
    const fetchFn = mockFetchOnce(400, 'bad');
    const client = new EmbeddingsClient(cfg, fetchFn);
    await expect(client.embed('hi')).rejects.toThrow(/400/);
    expect((fetchFn as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(1);
  });

  it('opens the circuit breaker after 5 consecutive failures', async () => {
    const fetchFn = mockFetchSequence(
      { status: 400, body: 'bad' },
      { status: 400, body: 'bad' },
      { status: 400, body: 'bad' },
      { status: 400, body: 'bad' },
      { status: 400, body: 'bad' },
    );
    const client = new EmbeddingsClient(cfg, fetchFn);
    for (let i = 0; i < 5; i++) {
      await expect(client.embed('x')).rejects.toThrow();
    }
    // Next call should short-circuit with EmbeddingUnavailableError.
    await expect(client.embed('x')).rejects.toBeInstanceOf(EmbeddingUnavailableError);
  });

  it('falls back to secondary model on non-retriable error', async () => {
    const fetchFn = mockFetchSequence(
      { status: 400, body: 'primary rejected' },
      { status: 200, body: { data: [{ embedding: [9, 9] }] } },
    );
    const client = new EmbeddingsClient(
      { ...cfg, fallbackModel: 'text-embedding-3-large' },
      fetchFn,
    );
    const vec = await client.embed('hi');
    expect(vec).toEqual([9, 9]);
  });

  it('rejects malformed response (missing data)', async () => {
    const fetchFn = mockFetchOnce(200, { foo: 'bar' });
    const client = new EmbeddingsClient(cfg, fetchFn);
    await expect(client.embed('hi')).rejects.toThrow(/malformed/);
  });

  it('resetBreaker closes the breaker', async () => {
    const fetchFn = mockFetchSequence(
      ...Array.from({ length: 5 }, () => ({ status: 400, body: 'bad' })),
      { status: 200, body: { data: [{ embedding: [0.1] }] } },
    );
    const client = new EmbeddingsClient(cfg, fetchFn);
    for (let i = 0; i < 5; i++) {
      await expect(client.embed('x')).rejects.toThrow();
    }
    client.resetBreaker();
    await expect(client.embed('x')).resolves.toEqual([0.1]);
  });
});
