// @direct-test-of packages/core/src/db/read-slots.ts
import { describe, expect, it } from 'vitest';
import { newQueryTiming, statementSent, withQueryTiming } from './query-timing.js';
import {
  idOfParts,
  memoizedPerId,
  partsOf,
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

describe('a batch at the quiet point', () => {
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

  it('outside a request, a read across projects batches in a scope of its own', async () => {
    const r = perId();
    const answers = await readAcross(['a', 'b', 'c'], String, (p) =>
      memoizedPerId('k', [p], r.read),
    );
    expect(answers.map((m) => [...m.keys()])).toEqual([['a'], ['b'], ['c']]);
    // one statement for the three projects, not one a project sent to the pool at once
    expect(r.asked).toEqual([['a', 'b', 'c']]);
  });

  describe('inside a read across projects', () => {
    const timed = <T>(fn: () => Promise<T>) =>
      withQueryTiming(newQueryTiming(), () => withReadMemo(fn));

    it("waits for a project's read that has yet to ask a key, so one a step behind still asks in the one statement", async () => {
      const k = perId();
      const j = perId();
      await timed(() =>
        readAcross(['a', 'b', 'c'], String, async (p) => {
          // a and c ask j first, a step b does not take, then every read asks k
          if (p !== 'b') await memoizedPerId('j', [p], j.read);
          return memoizedPerId('k', [p], k.read);
        }),
      );
      expect(j.asked).toEqual([['a', 'c']]);
      expect(k.asked).toEqual([['b', 'a', 'c']]);
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

    it('reads a key two shapes reach at different steps once, as the order learned from earlier reads shows', async () => {
      // a takes a step b and c skip: x before y; b and c ask y at once. Unlearned, each waits on a key
      // another has not asked, the key more of them asked is read first, and a asks y a step later
      // (ISS-1070 r9)
      const read = async () => {
        const x = perId();
        const y = perId();
        await timed(() =>
          readAcross(
            ['a', 'b', 'c'],
            String,
            async (p) => {
              if (p === 'a') await memoizedPerId('x', [p], x.read);
              return memoizedPerId('y', [p], y.read);
            },
            'two shapes',
          ),
        );
        return y.asked;
      };
      expect(await read()).toEqual([['b', 'c'], ['a']]);
      // the first read taught the order: a read waiting on x asks y after it
      expect(await read()).toEqual([['b', 'c', 'a']]);
      expect(await read()).toEqual([['b', 'c', 'a']]);
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

describe('a batch answer', () => {
  it('drops every id of a batch that failed, so the next ask reads them again', async () => {
    let calls = 0;
    const flaky = async (ids: readonly string[]) => {
      calls += 1;
      if (calls === 1) throw new Error('statement failed');
      return new Map(ids.map((id) => [id, { id }]));
    };
    await withReadMemo(() =>
      declaring(['p', 'q'], async () => {
        await expect(memoizedPerId('k', ['a', 'b'], flaky)).rejects.toThrow('statement failed');
        expect([...(await memoizedPerId('k', ['b', 'a'], flaky)).keys()]).toEqual(['b', 'a']);
      }),
    );
    expect(calls).toBe(2);
  });

  it("hands every asker of a batch the one answer, read-only down to each id's value", async () => {
    const r = perId();
    await withReadMemo(() =>
      declaring(['p', 'q'], async () => {
        const [first, second] = await Promise.all([
          memoizedPerId('k', ['a', 'b'], async (ids) => {
            await r.read(ids);
            return new Map(ids.map((id) => [id, { id, rows: [id] }]));
          }),
          memoizedPerId('k', ['b'], async () => new Map()),
        ]);
        const b = first.get('b') as { rows: string[] };
        expect(second.get('b')).toBe(b);
        expect(() => b.rows.push('changed')).toThrow(TypeError);
      }),
    );
    expect(r.asked).toEqual([['a', 'b']]);
  });
});
