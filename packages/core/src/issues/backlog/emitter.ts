/**
 * The loop every backlog stream shares (ISS-1173): meta, items, progress on a timer, and exactly
 * one terminal frame.
 *
 * A source is an async generator whose RETURN value says whether it ran out of rows or was stopped.
 * That distinction is the whole of the settled-versus-truncated contract: the emitter never infers
 * truncation from a count, because reaching `limit` proves nothing about what was behind it.
 */

import type { Context } from 'hono';
import type { SSEStreamingApi } from 'hono/streaming';
import { getLogger } from '../../logger.js';
import type { Cancellation } from './cancellation.js';
import { startBudget } from './cancellation.js';
import {
  type BacklogFrame,
  type BacklogStreamKind,
  SHUTTING_DOWN,
  sseMessage,
  type TruncationReason,
} from './frames.js';
import { registerBacklogStream } from './open-streams.js';

/** How often liveness is reported while a producer is still working. */
export const PROGRESS_INTERVAL_MS = 5_000;

/** What a source says when it stops: whether it had run out, or was cut off mid-work. */
export interface SourceDone {
  exhausted: boolean;
}

export type BacklogSource<T> = AsyncGenerator<T, SourceDone, undefined>;

export interface EmitOptions<T> {
  kind: BacklogStreamKind;
  projectId: string;
  /** Matching rows, counted once before the first item. */
  total: number;
  limit: number;
  budgetMs: number;
  cancellation: Cancellation;
  source: BacklogSource<T>;
}

/** Serializes every write, so the progress timer cannot interleave a frame with the item loop. */
class FrameWriter {
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly stream: SSEStreamingApi) {}

  write(frame: BacklogFrame): Promise<void> {
    this.tail = this.tail
      .then(() => this.stream.writeSSE(sseMessage(frame)))
      .catch(() => undefined);
    return this.tail;
  }

  settled(): Promise<void> {
    return this.tail;
  }
}

function truncationOf(cancellation: Cancellation): TruncationReason {
  return cancellation.reason === 'budget' ? 'budget' : null;
}

/**
 * Pulls one item past the bound to learn whether the bound cut anything. The extra item is
 * discarded: it is evidence about the source, not an answer the caller asked for.
 */
async function pastTheBound<T>(source: BacklogSource<T>): Promise<SourceDone> {
  const step = await source.next();
  return step.done ? step.value : { exhausted: false };
}

async function drain<T>(
  opts: EmitOptions<T>,
  writer: FrameWriter,
  onEmit: () => void,
): Promise<{ emitted: number; done: SourceDone; hitItemBound: boolean }> {
  let emitted = 0;
  for (;;) {
    // A stop observed at exactly the bound is that stop, not an item-bound truncation, and the
    // probe is itself work — at a page boundary it would schedule a read for a caller that has gone.
    if (opts.cancellation.cancelled) {
      return { emitted, done: { exhausted: false }, hitItemBound: false };
    }
    if (emitted >= opts.limit) {
      return { emitted, done: await pastTheBound(opts.source), hitItemBound: true };
    }
    const step = await opts.source.next();
    if (step.done) return { emitted, done: step.value, hitItemBound: false };
    emitted += 1;
    onEmit();
    await writer.write({ type: 'item', seq: emitted, payload: step.value });
  }
}

function terminalFrame(
  emitted: number,
  total: number,
  done: SourceDone,
  hitItemBound: boolean,
  cancellation: Cancellation,
): BacklogFrame {
  if (cancellation.reason === 'shutdown') {
    return { type: 'error', code: SHUTTING_DOWN, message: 'core is shutting down', emitted };
  }
  // Exhaustion beats the bound: a stream whose last item was also its `limit`-th is complete.
  if (done.exhausted) {
    return { type: 'end', complete: true, truncated: false, truncatedBy: null, emitted, total };
  }
  const truncatedBy: TruncationReason = hitItemBound ? 'items' : truncationOf(cancellation);
  return { type: 'end', complete: false, truncated: true, truncatedBy, emitted, total };
}

/**
 * Runs one stream to its end. Returns without writing anything once the client has gone: nobody is
 * reading, so a terminal frame there would be a write into a closed socket rather than an answer.
 */
export async function emitBacklogStream<T>(
  c: Context,
  stream: SSEStreamingApi,
  opts: EmitOptions<T>,
): Promise<void> {
  const log = getLogger(c);
  const startedAt = Date.now();
  const writer = new FrameWriter(stream);
  const { cancellation } = opts;

  stream.onAbort(() => cancellation.cancel('disconnect'));
  if (stream.aborted) cancellation.cancel('disconnect');

  const unregister = registerBacklogStream({
    cancellation,
    close: async () => {
      await writer.settled();
      await stream.close();
    },
  });
  let stopBudget: () => void = () => undefined;

  let emitted = 0;
  const ticker = setInterval(() => {
    if (cancellation.cancelled) return;
    void writer.write({
      type: 'progress',
      emitted,
      total: opts.total,
      elapsedMs: Date.now() - startedAt,
    });
  }, PROGRESS_INTERVAL_MS);
  ticker.unref?.();

  try {
    await writer.write({
      type: 'meta',
      kind: opts.kind,
      projectId: opts.projectId,
      total: opts.total,
      bound: { items: opts.limit, budgetMs: opts.budgetMs },
      at: new Date(startedAt).toISOString(),
    });
    stopBudget = startBudget(cancellation, opts.budgetMs);
    const run = await drain(opts, writer, () => {
      emitted += 1;
    });
    clearInterval(ticker);
    if (cancellation.reason === 'disconnect') return;
    await writer.write(
      terminalFrame(run.emitted, opts.total, run.done, run.hitItemBound, cancellation),
    );
  } catch (err) {
    clearInterval(ticker);
    if (cancellation.reason === 'disconnect') return;
    const cause = err as { code?: unknown; message?: unknown };
    const code = typeof cause?.code === 'string' ? cause.code : 'BACKLOG_STREAM_FAILED';
    const message = typeof cause?.message === 'string' ? cause.message : String(err);
    log.warn(
      { kind: opts.kind, projectId: opts.projectId, code, emitted },
      'backlog.stream failed',
    );
    await writer.write({ type: 'error', code, message, emitted });
  } finally {
    clearInterval(ticker);
    stopBudget();
    unregister();
    await opts.source.return({ exhausted: false }).catch(() => undefined);
    log.info(
      {
        kind: opts.kind,
        projectId: opts.projectId,
        emitted,
        elapsedMs: Date.now() - startedAt,
        stoppedBy: cancellation.reason,
      },
      'backlog.stream end',
    );
  }
}
