import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EmitResult } from './hooks.js';

interface FakeRow {
  id: string;
  issue_id: string;
  project_id: string;
  from_status: string;
  to_status: string;
  actor_id: string | null;
  actor_type: string | null;
  reason: string | null;
  attempts: number;
  created_at: Date;
}

/** What the next claim returns. Empty is an idle tick; one row is a claiming tick. */
const claimQueue: FakeRow[][] = [];

function sqlTextOf(q: unknown): string {
  const chunks = (q as { queryChunks?: unknown[] })?.queryChunks ?? [];
  let text = '';
  for (const c of chunks) {
    if (typeof c !== 'object' || c === null) continue;
    if ('queryChunks' in c) {
      text += sqlTextOf(c);
      continue;
    }
    if ('value' in c) {
      const v = (c as { value?: unknown }).value;
      if (Array.isArray(v)) text += v.filter((p): p is string => typeof p === 'string').join(' ');
      else if (typeof v === 'string') text += v;
    }
  }
  return text;
}

const dbExecute = vi.fn(async (q: unknown) => {
  const text = sqlTextOf(q);
  if (/UPDATE\s+pipeline_outbox\s+o/i.test(text) && /RETURNING/i.test(text)) {
    return claimQueue.shift() ?? [];
  }
  return [];
});

vi.mock('../db/client.js', () => ({ db: { execute: dbExecute, transaction: vi.fn() } }));

vi.mock('./hooks.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./hooks.js')>();
  return {
    ...actual,
    hooks: {
      emit: vi.fn(
        async (): Promise<EmitResult> => ({ topic: 'transition', delivered: 1, failures: [] }),
      ),
      on: vi.fn(),
    },
  };
});

vi.mock('./wedge.js', () => ({
  emitPipelineWedge: vi.fn(async () => {}),
  outboxDeadLetterEntityId: (id: string) => `outbox:${id}`,
}));

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { registerOutboxWorker, stopOutboxWorker } = await import('./outbox-worker.js');

function row(id: string): FakeRow {
  return {
    id,
    issue_id: 'issue-1',
    project_id: 'project-1',
    from_status: 'open',
    to_status: 'in_progress',
    actor_id: null,
    actor_type: null,
    reason: null,
    attempts: 0,
    created_at: new Date('2026-09-18T00:00:00.000Z'),
  };
}

/** Every delay the loop has asked for, in order. */
let delays: number[] = [];

beforeEach(() => {
  // No fake clock: the loop's callbacks are driven by hand below, so nothing here waits on time.
  // A fake clock on top of the spy would only give two things to advance instead of one.
  delays = [];
  claimQueue.length = 0;
  dbExecute.mockClear();
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((_fn: () => void, ms?: number) => {
    delays.push(ms ?? 0);
    return { unref: () => {} } as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout);
});

afterEach(async () => {
  // Restore FIRST: `stopOutboxWorker` waits out an in-flight tick with a real 10ms sleep.
  vi.mocked(globalThis.setTimeout).mockRestore();
  await stopOutboxWorker();
});

/** Run one tick by invoking whatever the loop last scheduled, and wait for it to re-arm. */
async function runScheduledTick(): Promise<void> {
  const before = delays.length;
  const calls = vi.mocked(globalThis.setTimeout).mock.calls;
  const scheduled = calls[calls.length - 1]?.[0] as (() => void) | undefined;
  // Nothing scheduled means the loop is not armed, which is a different failure from a tick that
  // ran and did not re-arm — say which.
  if (!scheduled) throw new Error('the poll is not armed: no timer was scheduled');
  scheduled();
  // The scheduled callback is `void tick()`, so the drain and the re-arm settle on the microtask
  // queue. Flushing a bounded number of times keeps a loop that never re-arms a failed assertion
  // rather than a hung suite.
  for (let i = 0; i < 50 && delays.length === before; i++) await Promise.resolve();
  if (delays.length === before) throw new Error('the tick did not re-arm the poll');
}

describe('the outbox poll backs off while idle and resets on work (ISS-1021)', () => {
  it('doubles the interval on each empty batch, up to the ceiling and no further', async () => {
    registerOutboxWorker();
    expect(delays).toEqual([1_000]);

    for (let i = 0; i < 5; i++) await runScheduledTick();

    // 1s is what `registerOutboxWorker` armed; every later number is a tick that claimed nothing.
    // The last two are the ceiling holding — a backoff with no `Math.min` reads 16s then 32s here,
    // and one with no doubling reads 1s throughout.
    expect(delays).toEqual([1_000, 2_000, 4_000, 8_000, 8_000, 8_000]);
  });

  it('returns to the base interval on the first batch that claims a row', async () => {
    registerOutboxWorker();
    for (let i = 0; i < 3; i++) await runScheduledTick();
    expect(delays[delays.length - 1]).toBe(8_000);

    claimQueue.push([row('aaaaaaaa-1111-4aaa-8aaa-aaaaaaaaaaaa')]);
    await runScheduledTick();

    // One row claimed, and the poll is back at its base rather than stepping down gradually —
    // a reset that halved instead would read 4000 here.
    expect(delays[delays.length - 1]).toBe(1_000);
  });

  it('backs off again once the queue empties after a claim', async () => {
    // The boundary between the two cases above: a reset implemented by pinning the interval would
    // pass both of them and never lengthen again.
    registerOutboxWorker();
    claimQueue.push([row('bbbbbbbb-1111-4bbb-8bbb-bbbbbbbbbbbb')]);
    await runScheduledTick();
    expect(delays[delays.length - 1]).toBe(1_000);

    await runScheduledTick();
    await runScheduledTick();

    expect(delays.slice(-2)).toEqual([2_000, 4_000]);
  });
});
