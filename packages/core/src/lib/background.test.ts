// Work no request waits on is known to `backgroundSettled()` until it has finished, including work it
// starts while a caller waits, and a throw goes to the work's own handler, never to the caller.

import { describe, expect, it } from 'vitest';
import { background, backgroundSettled } from './background.js';

const gate = () => {
  let open: () => void = () => {};
  const shut = new Promise<void>((r) => {
    open = r;
  });
  return { shut, open };
};

describe('background work', () => {
  it('keeps backgroundSettled waiting until it ends, and work it starts meanwhile too', async () => {
    const work = background();
    const first = gate();
    const second = gate();
    const done: string[] = [];
    work.start(
      async () => {
        await first.shut;
        done.push('first');
        work.start(
          async () => {
            await second.shut;
            done.push('second');
          },
          () => {},
        );
      },
      () => {},
    );

    let settled = false;
    const settling = backgroundSettled().then(() => {
      settled = true;
    });
    first.open();
    await new Promise((r) => setTimeout(r, 10));
    expect(settled).toBe(false);
    second.open();
    await settling;
    expect(done).toEqual(['first', 'second']);
  });

  it('hands a throw to its handler and settles', async () => {
    const work = background();
    const failures: unknown[] = [];
    work.start(
      () => Promise.reject(new Error('the write failed')),
      (err) => failures.push(err),
    );
    work.start(
      () => {
        throw new Error('it threw before it awaited');
      },
      (err) => failures.push(err),
    );
    await work.settled();
    expect(failures.map((e) => (e as Error).message).sort()).toEqual([
      'it threw before it awaited',
      'the write failed',
    ]);
  });

  it('settles one kind of work without waiting on another', async () => {
    const mine = background();
    const theirs = background();
    const held = gate();
    theirs.start(
      () => held.shut,
      () => {},
    );
    mine.start(
      async () => {},
      () => {},
    );
    await mine.settled();
    held.open();
    await theirs.settled();
  });
});
