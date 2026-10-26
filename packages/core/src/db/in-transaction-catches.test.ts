import { describe, expect, it } from 'vitest';
import {
  buildProgram,
  type GuardedCatch,
  guardedCatches,
  refusals,
} from './in-transaction-catches.fixture.js';

const PLANTED = 'db/in-transaction-catches.planted.ts';

const plant = `import { db, type Db, type Tx } from './client.js';
import { rethrowInTransaction } from './in-transaction.js';

class Refused extends Error {}

export async function swallowsAPick(executor: Pick<Db, 'select'>) {
  try {
    return await executor.select().from({} as never);
  } catch {
    return null;
  }
}

export async function swallowsInACallback() {
  return db.transaction(async (tx) => {
    try {
      await tx.execute('select 1' as never);
    } catch (err) {
      return String(err);
    }
    return 'ok';
  });
}

export async function swallowsAPromise(tx: Tx) {
  return tx.execute('select 1' as never).catch(() => null);
}

export async function rethrowsFirst(tx: Tx) {
  try {
    return await tx.execute('select 1' as never);
  } catch (err) {
    rethrowInTransaction(err, tx);
    return null;
  }
}

export async function narrowsFirst(tx: Tx) {
  try {
    return await tx.execute('select 1' as never);
  } catch (err) {
    if (!(err instanceof Refused)) throw err;
    return null;
  }
}

export async function swallowsOnThePool() {
  try {
    return await db.execute('select 1' as never);
  } catch {
    return null;
  }
}

export async function swallowsAWholeTransaction() {
  try {
    return await db.transaction(async (tx) => tx.execute('select 1' as never));
  } catch {
    return null;
  }
}
`;

const catches = guardedCatches(buildProgram(new Map([[PLANTED, plant]])));
const planted = catches.filter((c) => c.file === PLANTED);
const live = catches.filter((c) => c.file !== PLANTED);
const kindOf = (fn: string): GuardedCatch['handler'] | undefined =>
  planted.find((c) => c.fn === fn)?.handler;

describe('a catch around a statement on a handle that can be a transaction', () => {
  it('no catch in packages/core/src falls back inside a transaction', () => {
    expect(refusals(live)).toEqual([]);
  });

  it('reads the catches the transaction-ended fixes put rethrowInTransaction into', () => {
    const rethrowing = live.filter((c) => c.handler === 'rethrows').map((c) => c.fn);
    expect(rethrowing).toEqual(
      expect.arrayContaining([
        'contractAnswerForIssue',
        'computeProjectProgress',
        'projectLens',
        'issueRowsFor',
        'findMissingWorkEvidence',
        'hydrateSession',
      ]),
    );
  });

  it('refuses a planted swallow by file, line and function', () => {
    expect(refusals(planted)).toEqual([
      `${PLANTED}:9 swallowsAPick catches a statement on executor, which can be a transaction, and can fall back without rethrowInTransaction(<the error>, <the handle>) as its first statement`,
      `${PLANTED}:18 swallowsInACallback catches a statement on tx, which can be a transaction, and can fall back without rethrowInTransaction(<the error>, <the handle>) as its first statement`,
      `${PLANTED}:26 swallowsAPromise catches a statement on tx, which can be a transaction, and can fall back without rethrowInTransaction(<the error>, <the handle>) as its first statement`,
    ]);
  });

  it('passes a catch that rethrows inside a transaction first, or rethrows all it does not name', () => {
    expect(kindOf('rethrowsFirst')).toBe('rethrows');
    expect(kindOf('narrowsFirst')).toBe('narrowed');
  });

  it('leaves alone a catch on the pool, and one around a whole transaction', () => {
    expect(kindOf('swallowsOnThePool')).toBeUndefined();
    expect(kindOf('swallowsAWholeTransaction')).toBeUndefined();
  });

  it('allows a swallow only where an exception names it, and refuses an exception naming none', () => {
    const named = [{ at: `${PLANTED}:swallowsAPick`, reason: 'planted' }];
    expect(refusals(planted, named)).not.toContainEqual(expect.stringContaining('swallowsAPick'));
    expect(refusals([], [{ at: 'gone.ts:nothing', reason: 'planted' }])).toEqual([
      'EXCEPTIONS names gone.ts:nothing, where no catch falls back any more',
    ]);
  });
});
