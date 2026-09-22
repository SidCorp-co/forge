import type { Context } from 'hono';
import type { SSEStreamingApi } from 'hono/streaming';
import { describe, expect, it, vi } from 'vitest';
import { Cancellation } from './cancellation.js';
import { type BacklogSource, emitBacklogStream, PROGRESS_INTERVAL_MS } from './emitter.js';
import { closeBacklogStreams, openBacklogStreamCount } from './open-streams.js';

interface Written {
  event: string;
  data: Record<string, unknown>;
}

/** Stands in for Hono's SSEStreamingApi: the four members the emitter touches, and a record. */
function fakeStream() {
  const written: Written[] = [];
  let abort: (() => void) | null = null;
  const api = {
    written,
    aborted: false,
    closed: false,
    writeSSE: async (m: { event?: string; data: string }) => {
      written.push({ event: m.event ?? '', data: JSON.parse(m.data) });
    },
    onAbort: (listener: () => void) => {
      abort = listener;
    },
    close: async () => {
      api.closed = true;
    },
    disconnect: () => {
      api.aborted = true;
      abort?.();
    },
  };
  return api;
}

const ctx = { get: () => undefined } as unknown as Context;

/** A source of `n` items that reports honestly whether it ran out or was stopped. */
function countingSource(n: number, cancellation: Cancellation): BacklogSource<unknown> {
  return (async function* () {
    for (let i = 0; i < n; i++) {
      if (cancellation.cancelled) return { exhausted: false };
      yield { i };
    }
    return { exhausted: true };
  })();
}

async function run(opts: {
  items: number;
  limit: number;
  budgetMs?: number;
  cancellation?: Cancellation;
  source?: (c: Cancellation) => BacklogSource<unknown>;
  stream?: ReturnType<typeof fakeStream>;
}) {
  const cancellation = opts.cancellation ?? new Cancellation();
  const stream = opts.stream ?? fakeStream();
  await emitBacklogStream(ctx, stream as unknown as SSEStreamingApi, {
    kind: 'ordering',
    projectId: 'p1',
    total: opts.items,
    limit: opts.limit,
    budgetMs: opts.budgetMs ?? 300_000,
    cancellation,
    source: (opts.source ?? ((c) => countingSource(opts.items, c)))(cancellation),
  });
  return stream;
}

const kinds = (s: { written: Written[] }) => s.written.map((w) => w.data.type);
const terminal = (s: { written: Written[] }) => s.written[s.written.length - 1]?.data;

describe('emitBacklogStream', () => {
  it('opens with meta carrying the bounds it was given', async () => {
    const s = await run({ items: 2, limit: 10 });
    expect(s.written[0]?.data).toMatchObject({
      type: 'meta',
      kind: 'ordering',
      total: 2,
      bound: { items: 10, budgetMs: 300_000 },
    });
  });

  it('numbers items from one, in transport order', async () => {
    const s = await run({ items: 3, limit: 10 });
    expect(s.written.filter((w) => w.data.type === 'item').map((w) => w.data.seq)).toEqual([
      1, 2, 3,
    ]);
  });

  it('ends complete when the source ran out', async () => {
    const s = await run({ items: 3, limit: 10 });
    expect(terminal(s)).toEqual({
      type: 'end',
      complete: true,
      truncated: false,
      truncatedBy: null,
      emitted: 3,
      total: 3,
    });
  });

  it('ends complete when the last item was also the limit-th, because a count proves nothing', async () => {
    const s = await run({ items: 3, limit: 3 });
    expect(terminal(s)).toMatchObject({
      type: 'end',
      complete: true,
      truncated: false,
      emitted: 3,
    });
  });

  it('ends truncated by items when work remained behind the bound', async () => {
    const s = await run({ items: 5, limit: 3 });
    expect(terminal(s)).toMatchObject({
      type: 'end',
      complete: false,
      truncated: true,
      truncatedBy: 'items',
      emitted: 3,
    });
  });

  it('ends truncated by budget when the clock stopped it', async () => {
    const cancellation = new Cancellation();
    const source: BacklogSource<unknown> = (async function* () {
      yield { i: 0 };
      cancellation.cancel('budget');
      if (cancellation.cancelled) return { exhausted: false };
      yield { i: 1 };
      return { exhausted: true };
    })();
    const s = await run({ items: 9, limit: 100, cancellation, source: () => source });
    expect(terminal(s)).toMatchObject({
      type: 'end',
      complete: false,
      truncated: true,
      truncatedBy: 'budget',
      emitted: 1,
    });
  });

  it('ends with error naming the shutdown when core is winding down', async () => {
    const cancellation = new Cancellation();
    const source: BacklogSource<unknown> = (async function* () {
      yield { i: 0 };
      cancellation.cancel('shutdown');
      return { exhausted: false };
    })();
    const s = await run({ items: 9, limit: 100, cancellation, source: () => source });
    expect(terminal(s)).toMatchObject({ type: 'error', code: 'SERVER_SHUTTING_DOWN', emitted: 1 });
  });

  it('writes no terminal frame once the client has gone, because nobody is reading', async () => {
    const stream = fakeStream();
    const cancellation = new Cancellation();
    const source: BacklogSource<unknown> = (async function* () {
      yield { i: 0 };
      stream.disconnect();
      return { exhausted: false };
    })();
    await run({ items: 9, limit: 100, cancellation, source: () => source, stream });
    expect(kinds(stream)).toEqual(['meta', 'item']);
  });

  it('ends with error carrying the code and the count when the source throws', async () => {
    const source: BacklogSource<unknown> = (async function* () {
      yield { i: 0 };
      throw Object.assign(new Error('embeddings service unavailable'), {
        code: 'EMBEDDING_UNAVAILABLE',
      });
    })();
    const s = await run({ items: 9, limit: 100, source: () => source });
    expect(terminal(s)).toMatchObject({
      type: 'error',
      code: 'EMBEDDING_UNAVAILABLE',
      emitted: 1,
    });
  });

  it('emits exactly one terminal frame, with nothing after it', async () => {
    const s = await run({ items: 5, limit: 3 });
    const ends = s.written.filter((w) => w.data.type === 'end' || w.data.type === 'error');
    expect(ends).toHaveLength(1);
    expect(s.written[s.written.length - 1]).toBe(ends[0]);
  });

  it('reports progress on its own timer while a source produces nothing', async () => {
    vi.useFakeTimers();
    let release: () => void = () => undefined;
    const held = new Promise<void>((r) => {
      release = r;
    });
    const source: BacklogSource<unknown> = (async function* () {
      await held;
      yield* [];
      return { exhausted: true };
    })();
    const stream = fakeStream();
    const running = run({ items: 0, limit: 10, source: () => source, stream });

    await vi.advanceTimersByTimeAsync(PROGRESS_INTERVAL_MS * 2 + 10);
    expect(kinds(stream).filter((k) => k === 'progress').length).toBeGreaterThanOrEqual(2);

    release();
    vi.useRealTimers();
    await running;
  });

  it('is ended by shutdown rather than left holding the socket', async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((r) => {
      release = r;
    });
    const cancellation = new Cancellation();
    const source: BacklogSource<unknown> = (async function* () {
      yield { i: 0 };
      await held;
      return { exhausted: !cancellation.cancelled };
    })();
    const stream = fakeStream();
    const running = run({ items: 9, limit: 100, cancellation, source: () => source, stream });

    await vi.waitFor(() => expect(openBacklogStreamCount()).toBe(1));
    const closing = closeBacklogStreams();
    release();
    await running;
    await closing;

    expect(cancellation.reason).toBe('shutdown');
    expect(terminal(stream)).toMatchObject({ type: 'error', code: 'SERVER_SHUTTING_DOWN' });
    expect(openBacklogStreamCount()).toBe(0);
  });

  it('leaves the shutdown registry empty once it is done', async () => {
    await run({ items: 2, limit: 10 });
    expect(openBacklogStreamCount()).toBe(0);
  });
});
