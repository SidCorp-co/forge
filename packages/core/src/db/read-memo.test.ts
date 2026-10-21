import { describe, expect, it } from 'vitest';
import { memoizedRead, primeReads, withReadMemo } from './read-memo.js';

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

describe('primeReads', () => {
  const rows = [
    { projectId: 'a', n: 1 },
    { projectId: 'b', n: 2 },
    { projectId: 'a', n: 3 },
  ];

  it('answers every project the one statement read, in its order, and reads nothing more', async () => {
    let statements = 0;
    let own = 0;
    const readAll = async (ids: readonly string[]) => {
      statements += 1;
      return rows.filter((r) => ids.includes(r.projectId));
    };
    const ownRead = (id: string) => async () => {
      own += 1;
      return rows.filter((r) => r.projectId === id);
    };
    await withReadMemo(async () => {
      primeReads(
        ['a', 'b', 'c'],
        (id) => `rows:${id}`,
        readAll,
        (r) => r.projectId,
      );
      expect(await memoizedRead('rows:a', ownRead('a'))).toEqual([rows[0], rows[2]]);
      expect(await memoizedRead('rows:b', ownRead('b'))).toEqual([rows[1]]);
      expect(await memoizedRead('rows:c', ownRead('c'))).toEqual([]);
    });
    expect(statements).toBe(1);
    expect(own).toBe(0);
  });

  it('keeps an answer already held and primes only the rest', async () => {
    const asked: string[][] = [];
    await withReadMemo(async () => {
      await memoizedRead('rows:a', async () => [{ projectId: 'a', n: 9 }]);
      primeReads(
        ['a', 'b'],
        (id) => `rows:${id}`,
        async (ids) => {
          asked.push([...ids]);
          return rows.filter((r) => ids.includes(r.projectId));
        },
        (r) => r.projectId,
      );
      expect(await memoizedRead('rows:a', async () => [])).toEqual([{ projectId: 'a', n: 9 }]);
    });
    expect(asked).toEqual([['b']]);
  });

  it('reads nothing outside a request scope', () => {
    let statements = 0;
    primeReads(
      ['a'],
      (id) => id,
      async () => {
        statements += 1;
        return [];
      },
      () => 'a',
    );
    expect(statements).toBe(0);
  });

  it('does not keep a failed statement, so each project reads on its own', async () => {
    await withReadMemo(async () => {
      primeReads(
        ['a'],
        (id) => `rows:${id}`,
        async () => {
          throw new Error('statement failed');
        },
        () => 'a',
      );
      await expect(memoizedRead('rows:a', async () => [])).rejects.toThrow('statement failed');
      expect(await memoizedRead('rows:a', async () => [rows[0]])).toEqual([rows[0]]);
    });
  });
});

describe('a lazy thenable read (a query builder)', () => {
  /** Sends its statement on every `then`, as a drizzle query builder does. */
  const lazy = (sent: { n: number }, rows: { projectId: string }[]) =>
    ({
      then(ok: (v: unknown) => unknown, no?: (e: unknown) => unknown) {
        sent.n += 1;
        return Promise.resolve(rows).then(ok, no);
      },
    }) as unknown as Promise<{ projectId: string }[]>;

  it('is sent once however many projects and callers read it', async () => {
    const sent = { n: 0 };
    await withReadMemo(async () => {
      primeReads(
        ['a', 'b', 'c'],
        (id) => `rows:${id}`,
        () => lazy(sent, []),
        (r) => r.projectId,
      );
      await Promise.all(['a', 'b', 'c'].map((id) => memoizedRead(`rows:${id}`, async () => [])));
      await memoizedRead('own', () => lazy(sent, []));
      await memoizedRead('own', () => lazy(sent, []));
    });
    expect(sent.n).toBe(2);
  });
});
