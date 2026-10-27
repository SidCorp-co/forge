import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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

/** Holds of every error, so it names no kind of one. */
function isFailure(err: unknown): err is Error {
  return err instanceof Error;
}

/** Holds of every error, in a body the scan does not read. */
function isSeen(err: unknown): boolean {
  const seen = err !== undefined;
  return seen;
}

/** Holds of one error only. */
function isRefusal(err: unknown): boolean {
  return (err as { code?: string }).code === '23505';
}

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

export async function rethrowsOnlyTheNamed(tx: Tx) {
  try {
    return await tx.execute('select 1' as never);
  } catch (err) {
    if (err instanceof Refused) throw err;
    return null;
  }
}

export async function rethrowsOnlyNothing(tx: Tx) {
  try {
    return await tx.execute('select 1' as never);
  } catch (err) {
    if (!err) throw err;
    return null;
  }
}

export async function returnsUnlessNothing(tx: Tx) {
  try {
    return await tx.execute('select 1' as never);
  } catch (err) {
    if (err) return null;
    throw err;
  }
}

export async function returnsForTheNamed(tx: Tx) {
  try {
    return await tx.execute('select 1' as never);
  } catch (err) {
    if (err instanceof Refused) return null;
    throw err;
  }
}

export async function swallowsAnInsertOnly(executor: Pick<Tx, 'insert'>) {
  try {
    await executor.insert({} as never).values({} as never);
  } catch {
    return null;
  }
}

export async function swallowsAnUpdateOnly(runner: Pick<Tx, 'update'>) {
  try {
    await runner.update({} as never).set({} as never);
  } catch {
    return null;
  }
}

export async function swallowsAGeneric<E extends Pick<Db, 'select'>>(executor: E) {
  try {
    return await executor.select().from({} as never);
  } catch {
    return null;
  }
}

export async function returnsInFinally(tx: Tx) {
  try {
    return await tx.execute('select 1' as never);
  } finally {
    return null;
  }
}

export async function narrowsToEveryError(tx: Tx) {
  try {
    return await tx.execute('select 1' as never);
  } catch (err) {
    if (!(err instanceof Error)) throw err;
    return null;
  }
}

export async function narrowsToAnObject(tx: Tx) {
  try {
    return await tx.execute('select 1' as never);
  } catch (err) {
    if (typeof err !== 'object') throw err;
    return null;
  }
}

export async function narrowsByAHelperThatHoldsOfAll(tx: Tx) {
  try {
    return await tx.execute('select 1' as never);
  } catch (err) {
    if (!isFailure(err)) throw err;
    return null;
  }
}

export async function returnsWhenNotNothing(tx: Tx) {
  try {
    return await tx.execute('select 1' as never);
  } catch (err) {
    if (err !== undefined) return null;
    throw err;
  }
}

export async function narrowsByAHelperThatNamesOne(tx: Tx) {
  try {
    return await tx.execute('select 1' as never);
  } catch (err) {
    if (!isRefusal(err)) throw err;
    return null;
  }
}

export async function narrowsByCode(tx: Tx) {
  try {
    return await tx.execute('select 1' as never);
  } catch (err) {
    if ((err as { code?: string }).code !== '23505') throw err;
    return null;
  }
}

export async function narrowsByAHelperItCannotRead(tx: Tx) {
  try {
    return await tx.execute('select 1' as never);
  } catch (err) {
    if (!isSeen(err)) throw err;
    return null;
  }
}

export async function continuesThroughASwitch(tx: Tx, kinds: string[]) {
  for (const kind of kinds) {
    try {
      await tx.execute('select 1' as never);
    } finally {
      switch (kind) {
        case 'skip':
          continue;
      }
    }
  }
  return null;
}

export async function breaksInsideItsFinally(tx: Tx) {
  try {
    return await tx.execute('select 1' as never);
  } finally {
    inner: for (const n of [1]) {
      if (n) break inner;
    }
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

/**
 * The source of `file` under `src`, with the statement opening at `statement` wrapped in a catch
 * that swallows what it throws, as the scan would read a real swallow there.
 */
function swallowedIn(file: string, statement: string): string {
  const text = readFileSync(join(import.meta.dirname, '..', file), 'utf8');
  const at = text.indexOf(statement);
  if (at === -1) throw new Error(`${file} no longer holds \`${statement}\``);
  const ends = text.indexOf(';', at) + 1;
  return `${text.slice(0, at)}try { ${text.slice(at, ends)} } catch { return 0 as never; }${text.slice(ends)}`;
}

const WRITES = 'issues/attributes/write.ts';
const REFRESH = 'auth/refresh.ts';
/** One program for every plant: each build costs seconds. */
const catches = guardedCatches(
  buildProgram(
    new Map([
      [PLANTED, plant],
      [WRITES, swallowedIn(WRITES, 'await tx.insert(issueAttributes).values(many)')],
      [REFRESH, swallowedIn(REFRESH, 'await runner\n    .update(refreshTokens)')],
    ]),
  ),
);
const planted = catches.filter((c) => c.file === PLANTED);
const swallowedInSrc = catches.filter(
  (c) => (c.file === WRITES || c.file === REFRESH) && c.handler === 'swallows',
);
const live = catches.filter((c) => ![PLANTED, WRITES, REFRESH].includes(c.file));
/** The line of the first catch, or the finally of a try with none, after `fn` opens in the plant. */
function catchLine(fn: string): number {
  const opens = plant.search(new RegExp(`function ${fn}[<(]`));
  const next = (word: string) => plant.indexOf(word, opens);
  const caught = next('catch');
  const ends = next('finally');
  const at = ends !== -1 && (caught === -1 || ends < caught) ? ends : caught;
  return plant.slice(0, at).split('\n').length;
}
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
    const swallows = [
      ['swallowsAPick', 'executor'],
      ['swallowsInACallback', 'tx'],
      ['swallowsAPromise', 'tx'],
      ['rethrowsOnlyTheNamed', 'tx'],
      ['rethrowsOnlyNothing', 'tx'],
      ['returnsUnlessNothing', 'tx'],
      ['swallowsAnInsertOnly', 'executor'],
      ['swallowsAnUpdateOnly', 'runner'],
      ['swallowsAGeneric', 'executor'],
      ['returnsInFinally', 'tx'],
      ['narrowsToEveryError', 'tx'],
      ['narrowsToAnObject', 'tx'],
      ['narrowsByAHelperThatHoldsOfAll', 'tx'],
      ['returnsWhenNotNothing', 'tx'],
      ['narrowsByAHelperItCannotRead', 'tx'],
      ['continuesThroughASwitch', 'tx'],
    ];
    expect(refusals(planted)).toEqual(
      swallows.map(
        ([fn, handle]) =>
          `${PLANTED}:${catchLine(fn as string)} ${fn} catches a statement on ${handle}, which can be a transaction, and can fall back without rethrowInTransaction(<the error>, <the handle>) as its first statement`,
      ),
    );
  });

  it('sees a swallow on the executors src types by one member, insert or update alone', () => {
    // A swallow standing in either file beside the planted one is a third entry here.
    expect(swallowedInSrc.map((c) => `${c.file} ${c.fn} ${c.handles.join(',')}`)).toEqual([
      'auth/refresh.ts invalidateAllForUser runner',
      'issues/attributes/write.ts writeAttributes tx',
    ]);
  });

  it('passes a catch that rethrows inside a transaction first, or falls back only for an error it names', () => {
    expect(kindOf('rethrowsFirst')).toBe('rethrows');
    expect(kindOf('narrowsFirst')).toBe('narrowed');
    expect(kindOf('returnsForTheNamed')).toBe('narrowed');
    expect(kindOf('narrowsByAHelperThatNamesOne')).toBe('narrowed');
    expect(kindOf('narrowsByCode')).toBe('narrowed');
  });

  it('leaves alone a catch on the pool, one around a whole transaction, and a finally whose jump lands inside it', () => {
    expect(kindOf('swallowsOnThePool')).toBeUndefined();
    expect(kindOf('swallowsAWholeTransaction')).toBeUndefined();
    expect(kindOf('breaksInsideItsFinally')).toBeUndefined();
  });

  it('allows a swallow only where an exception names it, and refuses an exception naming none', () => {
    const named = [{ at: `${PLANTED}:swallowsAPick`, reason: 'planted' }];
    expect(refusals(planted, named)).not.toContainEqual(expect.stringContaining('swallowsAPick'));
    expect(refusals([], [{ at: 'gone.ts:nothing', reason: 'planted' }])).toEqual([
      'EXCEPTIONS names gone.ts:nothing, where no catch falls back any more',
    ]);
  });
});
