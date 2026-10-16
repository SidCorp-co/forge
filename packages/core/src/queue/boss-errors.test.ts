// The pg-boss instance never runs without an `error` listener: the event it emits from a worker's
// loop is logged and counted, where before it was thrown out of emit() and the process exited.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const logged = vi.hoisted(() => ({ error: vi.fn() }));
vi.mock('../lib/logger.js', () => ({
  logger: { error: logged.error, warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const { boss } = await import('./boss.js');
const { bossErrorTally } = await import('./boss-errors.js');

// what pg-boss 12's Worker hands its onError when a fetch or a settle throws (manager.js `work`)
// pg-boss types the event as an Error and emits a spread copy of one, so the plain shape is cast
const workerFailure = {
  message: 'deadlock detected (Queue: outbox.master-wake, Worker: w-1)',
  stack: 'Error: deadlock detected\n    at fetch',
  queue: 'outbox.master-wake',
  worker: 'w-1',
} as unknown as Error;

beforeEach(() => logged.error.mockClear());

describe('a pg-boss error event', () => {
  it('is listened to, so emitting one does not throw ERR_UNHANDLED_ERROR', () => {
    expect(boss.listenerCount('error')).toBeGreaterThanOrEqual(1);
    expect(() => boss.emit('error', workerFailure)).not.toThrow();
  });

  it('is one error line naming the queue and the worker, and is counted', () => {
    const before = bossErrorTally().count;
    boss.emit('error', workerFailure);
    expect(logged.error).toHaveBeenCalledTimes(1);
    const [fields, msg] = logged.error.mock.calls[0] as [Record<string, unknown>, string];
    expect(msg).toBe('pg-boss: a failure inside its own loop');
    expect(fields).toMatchObject({ queue: 'outbox.master-wake', worker: 'w-1' });
    expect((fields.err as Error).message).toContain('deadlock detected');
    const tally = bossErrorTally();
    expect(tally.count).toBe(before + 1);
    expect(tally.last).toMatchObject({ queue: 'outbox.master-wake', worker: 'w-1' });
  });

  it('takes a real Error with no queue as well, naming none', () => {
    boss.emit('error', new Error('maintenance pass failed'));
    const [fields] = logged.error.mock.calls[0] as [Record<string, unknown>];
    expect(fields).toMatchObject({ queue: null, worker: null });
    expect(bossErrorTally().last?.message).toBe('maintenance pass failed');
  });
});
