import { describe, expect, it } from 'vitest';
import { glanceCache } from './glance-cache.js';

/** A cache over a counter: each read of a key answers how many reads of it there were. */
function counted() {
  let reads = 0;
  let gate: Promise<void> = Promise.resolve();
  const cache = glanceCache<number>(
    'test',
    30_000,
    async () => {
      reads += 1;
      const n = reads;
      await gate;
      return n;
    },
    { concurrency: 1 },
  );
  return {
    cache,
    hold() {
      let open = () => {};
      gate = new Promise<void>((r) => {
        open = r;
      });
      return open;
    },
  };
}

const settled = () => new Promise<void>((r) => setTimeout(r, 20));

describe('a glance marked stale is read again on the next read (ISS-1053)', () => {
  it('a fresh glance marked stale serves what it holds, starts its refresh and says so', async () => {
    const { cache } = counted();
    await cache.read(['a'], 1_000);
    const fresh = await cache.read(['a']);
    expect(fresh.refreshing).toBe(false);
    expect(cache.stale((k) => k === 'a')).toBe(1);
    const next = await cache.read(['a']);
    expect(next.values.get('a')).toEqual({ read: true, value: 1 });
    expect(next.refreshing).toBe(true);
    await settled();
    expect((await cache.read(['a'])).values.get('a')).toEqual({ read: true, value: 2 });
  });

  it('marks only the keys it names', async () => {
    const { cache } = counted();
    await cache.read(['a', 'b'], 1_000);
    expect(cache.stale((k) => k === 'b')).toBe(1);
    const next = await cache.read(['a']);
    expect(next.refreshing).toBe(false);
  });

  it('a read running when the mark was made lands stale, so the next read starts another', async () => {
    const { cache, hold } = counted();
    await cache.read(['a'], 1_000);
    cache.stale(() => true);
    const open = hold();
    await cache.read(['a']);
    await settled();
    // the refresh is reading behind the page when the project moves again
    expect(cache.stale(() => true)).toBe(1);
    open();
    await settled();
    const after = await cache.read(['a']);
    expect(after.values.get('a')).toEqual({ read: true, value: 2 });
    expect(after.refreshing, 'a read begun before the move was served as fresh').toBe(true);
    await settled();
    expect((await cache.read(['a'])).values.get('a')).toEqual({ read: true, value: 3 });
  });
});
