import { describe, expect, it } from 'vitest';
import { createLimiter } from './bounded-concurrency.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

describe('createLimiter', () => {
  it('refuses a limit that is not a positive integer rather than running unbounded', () => {
    expect(() => createLimiter(0)).toThrow(RangeError);
    expect(() => createLimiter(-1)).toThrow(RangeError);
    expect(() => createLimiter(1.5)).toThrow(RangeError);
  });

  // cm:guard the assertion is the PEAK, not the final count: a limiter that lets every task start at once still ends with inFlight 0, so a test reading only the end state passes against no bound at all.
  it('never lets more than `limit` tasks run at once, across interleaved callers', async () => {
    const limiter = createLimiter(3);
    const gates = Array.from({ length: 12 }, () => deferred<number>());
    let running = 0;
    let peak = 0;

    const runs = gates.map((gate, i) =>
      limiter.run(async () => {
        running += 1;
        peak = Math.max(peak, running);
        const value = await gate.promise;
        running -= 1;
        return value;
      }),
    );

    await flush();
    expect(peak).toBe(3);
    expect(limiter.inFlight).toBe(3);
    expect(limiter.waiting).toBe(9);

    for (const [i, gate] of gates.entries()) {
      gate.resolve(i);
      await flush();
      expect(peak).toBeLessThanOrEqual(3);
    }

    expect(await Promise.all(runs)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(peak).toBe(3);
  });

  // cm:guard the mock queue in health-routes.test.ts feeds one row-set per await IN ORDER, so a limiter that started parked tasks out of order would hand each query another query's rows and the route would answer a coherent-looking lie.
  it('starts parked tasks in the order they asked, so a caller keyed on order still reads its own', async () => {
    const limiter = createLimiter(2);
    const started: number[] = [];
    const gates = Array.from({ length: 6 }, () => deferred<void>());

    const runs = gates.map((gate, i) =>
      limiter.run(async () => {
        started.push(i);
        await gate.promise;
        return i;
      }),
    );

    await flush();
    expect(started).toEqual([0, 1]);
    for (const gate of gates) {
      gate.resolve();
      await flush();
    }
    await Promise.all(runs);
    expect(started).toEqual([0, 1, 2, 3, 4, 5]);
  });

  // cm:guard THIS is the case that separates handing the slot on from returning it to a counter, and nothing else here does: a caller arriving between a release and the parked task waking sees a slot already spoken for. Every other case here passes against the counter form.
  it('does not over-subscribe when a caller arrives while a parked task is waking', async () => {
    const limiter = createLimiter(1);
    let running = 0;
    let peak = 0;
    const gates = [deferred<void>(), deferred<void>(), deferred<void>()];
    const body = (gate: { promise: Promise<void> }) => async () => {
      running += 1;
      peak = Math.max(peak, running);
      await gate.promise;
      running -= 1;
    };

    const first = limiter.run(body(gates[0] as { promise: Promise<void> }));
    const parked = limiter.run(body(gates[1] as { promise: Promise<void> }));
    await flush();
    expect(peak).toBe(1);

    // cm:why two microtasks IS the window, measured: the holder's body resumes on the first and its release runs on the second, so a caller arriving now sits between the release and the parked task's resumption.
    // One tick is too early and three too late — at either the counter form also reads 1, so this number is a measurement rather than a guess.
    gates[0]?.resolve();
    await Promise.resolve();
    await Promise.resolve();
    const late = limiter.run(body(gates[2] as { promise: Promise<void> }));

    await flush();
    expect(peak).toBe(1);

    for (const gate of gates) gate.resolve();
    await Promise.all([first, parked, late]);
    expect(peak).toBe(1);
    expect(limiter.inFlight).toBe(0);
  });

  it('releases the slot of a task that threw, so one failure does not wedge the limiter', async () => {
    const limiter = createLimiter(1);
    await expect(
      limiter.run(async () => {
        throw new Error('read failed');
      }),
    ).rejects.toThrow('read failed');

    expect(limiter.inFlight).toBe(0);
    expect(limiter.waiting).toBe(0);
    await expect(limiter.run(async () => 'next')).resolves.toBe('next');
  });

  it('hands a parked task the slot of one that threw', async () => {
    const limiter = createLimiter(1);
    const first = deferred<string>();
    const failing = limiter.run(() => first.promise);
    const parked = limiter.run(async () => 'ran anyway');

    await flush();
    expect(limiter.waiting).toBe(1);
    first.reject(new Error('boom'));

    await expect(failing).rejects.toThrow('boom');
    await expect(parked).resolves.toBe('ran anyway');
    expect(limiter.inFlight).toBe(0);
  });
});
