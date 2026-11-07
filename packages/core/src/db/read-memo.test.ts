import { describe, expect, it } from 'vitest';
import { newQueryTiming, statementSent, withQueryTiming } from './query-timing.js';
import {
  heldRead,
  idOfParts,
  memoizedPerId,
  memoizedRead,
  offerRead,
  partsOf,
  perProjectRead,
  readAcross,
  rowsPerId,
  rowsPerProject,
  withReadMemo,
} from './read-memo.js';

/**
 * Runs `fn` as one project's read in a request that declared a read across `projects`
 * (`readAcross`), where asks wait for the quiet point and are read together; the other projects'
 * reads end at once.
 */
const declaring = async <T>(projects: readonly string[], fn: () => Promise<T>): Promise<T> =>
  (await readAcross(projects, String, async (p) => (p === projects[0] ? fn() : undefined)))[0] as T;

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

  it('hands every caller the one answer, read-only: a caller writing into it throws there', async () => {
    const c = counter();
    await withReadMemo(async () => {
      const first = await memoizedRead('k', c.read);
      expect(() => first.list.push(3)).toThrow(TypeError);
      expect(await memoizedRead('k', c.read)).toBe(first);
      expect(first.list).toEqual([1, 2]);
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

describe('perProjectRead', () => {
  const rows = [
    { projectId: 'a', n: 1 },
    { projectId: 'b', n: 2 },
    { projectId: 'a', n: 3 },
  ];
  /** One statement over the projects it is asked for; records what it was asked. */
  const across = () => {
    const asked: string[][] = [];
    return {
      asked,
      readAll: async (ids: readonly string[]) => {
        asked.push([...ids]);
        return rows.filter((r) => ids.includes(r.projectId));
      },
    };
  };
  const ns = (list: { n: number }[]) => list.map((r) => r.n);
  const read = (r: ReturnType<typeof across>, id: string) =>
    perProjectRead('rows', id, r.readAll, (x) => x.projectId, ns);

  it('reads the one project asked, every time, outside a request scope', async () => {
    const r = across();
    expect(await read(r, 'a')).toEqual([1, 3]);
    expect(await read(r, 'a')).toEqual([1, 3]);
    expect(r.asked).toEqual([['a'], ['a']]);
  });

  it('reads every project asked together in one statement, each answered from its own rows as alone', async () => {
    const r = across();
    const alone = across();
    const [a, b, c] = [await read(alone, 'a'), await read(alone, 'b'), await read(alone, 'c')];
    await withReadMemo(() =>
      declaring(['b', 'a', 'c'], async () => {
        expect(await Promise.all([read(r, 'b'), read(r, 'a'), read(r, 'c')])).toEqual([b, a, c]);
        expect(await read(r, 'a')).toEqual(a);
      }),
    );
    expect(r.asked).toEqual([['b', 'a', 'c']]);
  });

  it('reads a project at once, once, in a request that declared one project at most', async () => {
    const r = across();
    await withReadMemo(async () => {
      expect(await Promise.all([read(r, 'a'), read(r, 'a')])).toEqual([
        [1, 3],
        [1, 3],
      ]);
      expect(await read(r, 'b')).toEqual([2]);
    });
    expect(r.asked).toEqual([['a'], ['b']]);
  });

  it('keeps no failed statement, so the next ask reads again and fails or answers on its own', async () => {
    let calls = 0;
    const flaky = async (ids: readonly string[]) => {
      calls += 1;
      if (calls === 1) throw new Error('statement failed');
      return rows.filter((r) => ids.includes(r.projectId));
    };
    await withReadMemo(async () => {
      const ask = (id: string) => perProjectRead('rows', id, flaky, (x) => x.projectId, ns);
      await expect(ask('a')).rejects.toThrow('statement failed');
      expect(await ask('b')).toEqual([2]);
    });
    expect(calls).toBe(2);
  });

  it("refuses a caller writing into a project's rows, so no other caller's answer changes", async () => {
    const r = across();
    await withReadMemo(async () => {
      const ask = () =>
        perProjectRead(
          'rows',
          'a',
          r.readAll,
          (x) => x.projectId,
          (l) => l,
        );
      const first = await ask();
      expect(() => {
        (first[0] as { n: number }).n = 99;
      }).toThrow(TypeError);
      expect((await ask()).map((x) => x.n)).toEqual([1, 3]);
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
    await withReadMemo(() =>
      declaring(['a', 'b', 'c'], async () => {
        await Promise.all(
          ['a', 'b', 'c'].map((id) =>
            rowsPerProject(
              'rows',
              id,
              () => lazy(sent, []),
              (r) => r.projectId,
            ),
          ),
        );
        await memoizedRead('own', () => lazy(sent, []));
        await memoizedRead('own', () => lazy(sent, []));
      }),
    );
    expect(sent.n).toBe(2);
  });
});

describe('memoizedPerId', () => {
  /** A read per id: each id's value is its own, whichever ids it is asked with; records what it was asked. */
  const perId = () => {
    const asked: string[][] = [];
    return {
      asked,
      read: async (ids: readonly string[]) => {
        asked.push([...ids]);
        return new Map(ids.filter((id) => id !== 'none').map((id) => [id, { id, rows: [id] }]));
      },
    };
  };

  it('sends no read for an empty list, inside a scope or outside one', async () => {
    const r = perId();
    expect((await memoizedPerId('k', [], r.read)).size).toBe(0);
    await withReadMemo(async () => {
      expect((await memoizedPerId('k', [], r.read)).size).toBe(0);
    });
    expect(r.asked).toEqual([]);
  });

  it('reads every id itself outside a request scope', async () => {
    const r = perId();
    await memoizedPerId('k', ['a', 'b'], r.read);
    await memoizedPerId('k', ['a', 'b'], r.read);
    expect(r.asked).toEqual([
      ['a', 'b'],
      ['a', 'b'],
    ]);
  });

  it('reads only the ids no earlier ask held, and answers each id as its own read would', async () => {
    const r = perId();
    await withReadMemo(() =>
      declaring(['p', 'q'], async () => {
        const first = await memoizedPerId('k', ['a', 'b', 'none'], r.read);
        const second = await memoizedPerId('k', ['b', 'c', 'none'], r.read);
        expect([...first.keys()]).toEqual(['a', 'b']);
        expect(second).toEqual(await r.read(['b', 'c', 'none']));
      }),
    );
    // 'b' and 'none' (a held answer of nothing) are not asked twice; the last ask is the comparison
    expect(r.asked).toEqual([['a', 'b', 'none'], ['c'], ['b', 'c', 'none']]);
  });

  it('shares an ask still in flight, and keys apart what two reads keep apart', async () => {
    const r = perId();
    await withReadMemo(() =>
      declaring(['p', 'q'], () =>
        Promise.all([
          memoizedPerId('k', ['a', 'b'], r.read),
          memoizedPerId('k', ['a'], r.read),
          memoizedPerId('other', ['a'], r.read),
        ]),
      ),
    );
    expect(r.asked).toEqual([['a', 'b'], ['a']]);
  });

  it('reads each set of ids once, whichever order they were asked in, in a request that declared one project at most', async () => {
    const r = perId();
    await withReadMemo(async () => {
      const first = await memoizedPerId('k', ['b', 'a', 'none'], r.read);
      // a set overlapping one already read is read whole: which ask came first changes no count
      const second = await memoizedPerId('k', ['b', 'c'], r.read);
      const again = await memoizedPerId('k', ['none', 'a', 'b'], r.read);
      expect([...first.keys()]).toEqual(['b', 'a']);
      expect([...second.keys()]).toEqual(['b', 'c']);
      expect(again).toEqual(new Map([...first].reverse()));
    });
    expect(r.asked).toEqual([
      ['a', 'b', 'none'],
      ['b', 'c'],
    ]);
  });

  it("refuses a caller writing into an id's answer or its rows, so no other caller's answer changes", async () => {
    const r = perId();
    await withReadMemo(async () => {
      const first = await memoizedPerId('k', ['a'], r.read);
      const a = first.get('a') as { id: string; rows: string[] };
      expect(() => a.rows.push('changed')).toThrow(TypeError);
      expect(() => {
        a.id = 'b';
      }).toThrow(TypeError);
      // the map handed over is the caller's own: adding to it changes nobody else's
      first.set('z', { id: 'z', rows: [] });
      expect((await memoizedPerId('k', ['a'], r.read)).get('a')?.rows).toEqual(['a']);
    });
  });

  it('does not keep a failed read: the next ask reads those ids again', async () => {
    let calls = 0;
    const flaky = async (ids: readonly string[]) => {
      calls += 1;
      if (calls === 1) throw new Error('statement failed');
      return new Map(ids.map((id) => [id, id]));
    };
    await withReadMemo(async () => {
      await expect(memoizedPerId('k', ['a'], flaky)).rejects.toThrow('statement failed');
      expect(await memoizedPerId('k', ['a'], flaky)).toEqual(new Map([['a', 'a']]));
    });
  });
});

describe('offerRead and heldRead', () => {
  it('holds an offered answer for later asks in the same read, and nothing outside one', async () => {
    expect(heldRead('k')).toBeUndefined();
    await offerRead('k', async () => 1);
    expect(heldRead('k')).toBeUndefined();
    await withReadMemo(async () => {
      expect(heldRead('k')).toBeUndefined();
      const offered = offerRead('k', async () => 2);
      expect(await heldRead('k')).toBe(2);
      expect(await offered).toBe(2);
    });
  });

  it('never hands a read its own answer while it is being made, so it cannot wait on itself', async () => {
    await withReadMemo(async () => {
      const made = offerRead('k', async () => {
        await Promise.resolve();
        return heldRead('k') === undefined ? 'not held inside' : 'held inside';
      });
      expect(await made).toBe('not held inside');
      expect(await heldRead('k')).toBe('not held inside');
    });
  });

  it('drops an offer that failed, so a later ask reads on its own', async () => {
    await withReadMemo(async () => {
      await expect(
        offerRead('k', async () => {
          throw new Error('list refused');
        }),
      ).rejects.toThrow('list refused');
      expect(heldRead('k')).toBeUndefined();
    });
  });
});

describe('a batch at the quiet point', () => {
  const perId = () => {
    const asked: string[][] = [];
    return {
      asked,
      read: async (ids: readonly string[]) => {
        asked.push([...ids]);
        return new Map(ids.map((id) => [id, id]));
      },
    };
  };
  const turns = (n: number) =>
    Array.from({ length: n }).reduce<Promise<void>>(
      (p) => p.then(() => new Promise((ok) => setImmediate(ok))),
      Promise.resolve(),
    );

  it('waits while a statement of the request is out, then reads every ask made meanwhile at once', async () => {
    const r = perId();
    const timing = newQueryTiming();
    await withQueryTiming(timing, () =>
      withReadMemo(() =>
        declaring(['p', 'q'], async () => {
          const answered = statementSent(timing);
          const first = memoizedPerId('k', ['a'], r.read);
          // a read that asks several turns later, while the statement is still out, joins the batch
          await turns(3);
          const second = memoizedPerId('k', ['b'], r.read);
          expect(r.asked).toEqual([]);
          answered();
          expect([...(await first).keys(), ...(await second).keys()]).toEqual(['a', 'b']);
        }),
      ),
    );
    expect(r.asked).toEqual([['a', 'b']]);
  });

  it('does not wait for the quiet point in a request that declared one project at most', async () => {
    const r = perId();
    const timing = newQueryTiming();
    await withQueryTiming(timing, () =>
      withReadMemo(async () => {
        const answered = statementSent(timing);
        // the statement still out holds nothing back: the ask is read beside it
        expect([...(await memoizedPerId('k', ['a'], r.read)).keys()]).toEqual(['a']);
        expect(r.asked).toEqual([['a']]);
        answered();
      }),
    );
  });

  it('reads at the end of the turn outside a timed request', async () => {
    const r = perId();
    await withReadMemo(() =>
      declaring(['p', 'q'], async () => {
        const first = memoizedPerId('k', ['a'], r.read);
        await turns(3);
        await memoizedPerId('k', ['b'], r.read);
        await first;
      }),
    );
    expect(r.asked).toEqual([['a'], ['b']]);
  });

  it('answers rows by id in the order each statement sent them', async () => {
    const rows = [
      { id: 'b', n: 1 },
      { id: 'a', n: 2 },
      { id: 'b', n: 3 },
    ];
    await withReadMemo(async () => {
      const fetch = async (ids: readonly string[]) => rows.filter((r) => ids.includes(r.id));
      const [both, a] = await Promise.all([
        rowsPerId('rows', ['a', 'b'], fetch, (r) => r.id),
        rowsPerId('rows', ['a'], fetch, (r) => r.id),
      ]);
      expect(both).toEqual(rows);
      expect(a).toEqual([rows[1]]);
    });
  });

  it('joins and splits an id of several parts', () => {
    expect(partsOf(idOfParts('p', 'v1.2'))).toEqual(['p', 'v1.2']);
  });

  describe('inside a read across projects', () => {
    const timed = <T>(fn: () => Promise<T>) =>
      withQueryTiming(newQueryTiming(), () => withReadMemo(fn));

    it("waits for a project's read that has yet to ask a key, so one a step behind still asks in the one statement", async () => {
      const k = perId();
      const j = perId();
      await timed(() =>
        readAcross(['a', 'b', 'c'], String, async (p) => {
          // b asks j first, a step a and c do not take, then every read asks k
          if (p === 'b') await memoizedPerId('j', [p], j.read);
          return memoizedPerId('k', [p], k.read);
        }),
      );
      expect(j.asked).toEqual([['b']]);
      expect(k.asked).toEqual([['a', 'c', 'b']]);
    });

    it('reads each ask apart where the reads run side by side without it', async () => {
      const k = perId();
      const j = perId();
      await timed(() =>
        Promise.all(
          ['a', 'b', 'c'].map(async (p) => {
            if (p === 'b') await memoizedPerId('j', [p], j.read);
            return memoizedPerId('k', [p], k.read);
          }),
        ),
      );
      expect(k.asked).toEqual([['a'], ['c'], ['b']]);
    });

    it("stops waiting for a project's read once it ends without asking", async () => {
      const k = perId();
      const j = perId();
      const answers = await timed(() =>
        readAcross(['a', 'b'], String, async (p) =>
          p === 'a' ? memoizedPerId('k', [p], k.read) : memoizedPerId('j', [p], j.read),
        ),
      );
      expect(answers.map((m) => [...m.keys()])).toEqual([['a'], ['b']]);
      expect(k.asked).toEqual([['a']]);
    });

    it('reads what every read waits on once nothing else can run, so two reads waiting on each other end', async () => {
      const k = perId();
      const j = perId();
      const answers = await timed(() =>
        readAcross(['a', 'b'], String, async (p) => {
          const first = await memoizedPerId(
            p === 'a' ? 'k' : 'j',
            [p],
            p === 'a' ? k.read : j.read,
          );
          const second = await memoizedPerId(
            p === 'a' ? 'j' : 'k',
            [p],
            p === 'a' ? j.read : k.read,
          );
          return [...first.keys(), ...second.keys()];
        }),
      );
      expect(answers).toEqual([
        ['a', 'a'],
        ['b', 'b'],
      ]);
    });

    it('reads a key by project for every project declared, the first ask among them', async () => {
      const asked: string[][] = [];
      const fetch = async (ids: readonly string[]) => {
        asked.push([...ids]);
        return ids.map((project) => ({ project }));
      };
      const rows = await timed(() =>
        readAcross(['p1', 'p2'], String, async (p) => {
          if (p === 'p2') await turns(2);
          return rowsPerProject('rows', p, fetch, (r) => r.project);
        }),
      );
      expect(rows).toEqual([[{ project: 'p1' }], [{ project: 'p2' }]]);
      expect(asked).toEqual([['p1', 'p2']]);
    });
  });
});
