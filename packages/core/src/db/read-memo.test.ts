import { describe, expect, it } from 'vitest';
import { memoizedRead, withReadMemo } from './read-memo.js';

const counter = () => {
  let calls = 0;
  return {
    read: async () => {
      calls += 1;
      return { calls, list: [1, 2] };
    },
    get calls() {
      return calls;
    },
  };
};

describe('memoizedRead', () => {
  it('reads every time outside a request scope', async () => {
    const c = counter();
    await memoizedRead('k', c.read);
    await memoizedRead('k', c.read);
    expect(c.calls).toBe(2);
  });

  it('reads once per key inside a scope, concurrent asks included', async () => {
    const c = counter();
    await withReadMemo(async () => {
      const [a, b] = await Promise.all([memoizedRead('k', c.read), memoizedRead('k', c.read)]);
      await memoizedRead('k', c.read);
      await memoizedRead('other', c.read);
      expect(a).toEqual(b);
    });
    expect(c.calls).toBe(2);
  });

  it('hands each caller its own copy', async () => {
    const c = counter();
    await withReadMemo(async () => {
      const first = await memoizedRead('k', c.read);
      first.list.push(3);
      expect((await memoizedRead('k', c.read)).list).toEqual([1, 2]);
    });
  });

  it('does not keep a failed read, so the next ask fails or succeeds on its own', async () => {
    let calls = 0;
    const flaky = async () => {
      calls += 1;
      if (calls === 1) throw new Error('first read failed');
      return calls;
    };
    await withReadMemo(async () => {
      await expect(memoizedRead('k', flaky)).rejects.toThrow('first read failed');
      expect(await memoizedRead('k', flaky)).toBe(2);
    });
  });

  it('does not share answers between two scopes', async () => {
    const c = counter();
    await withReadMemo(() => memoizedRead('k', c.read));
    await withReadMemo(() => memoizedRead('k', c.read));
    expect(c.calls).toBe(2);
  });
});
