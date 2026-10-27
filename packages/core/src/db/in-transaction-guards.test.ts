import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SESSION_ENDED_CODES } from '../lib/db-errors.js';
import { buildProgram, guardedCatches, refusals } from './in-transaction-catches.fixture.js';

const PLANTED = 'db/in-transaction-guards.planted.ts';

const plant = `import { type Tx } from './client.js';
import { pgErrorCode } from '../lib/db-errors.js';

class Patched extends Error {}
Object.defineProperty(Patched, Symbol.hasInstance, { value: () => true });

class PatchedBase extends Error {}
class InheritsThePatch extends PatchedBase {}
Object.defineProperty(PatchedBase, Symbol.hasInstance, { value: () => true });

class PatchedThroughAnAlias extends Error {}
const Alias = PatchedThroughAnAlias;
Object.defineProperty(Alias, Symbol.hasInstance, { value: () => true });

class WrittenByIndex extends Error {}
(WrittenByIndex as unknown as Record<symbol, unknown>)[Symbol.hasInstance] = () => true;

class Kept extends Error {
  constructor() {
    super('kept');
    Error.captureStackTrace(this, Kept);
  }
}

/** Its comparand defaults to the error's own code, so it holds of every error. */
function isCodeDefaulted(e: unknown, c: '23505' = (e as { code: '23505' }).code) {
  return (e as { code?: string }).code === c;
}

/** Its comparand defaults to a literal, so it holds of one error. */
function hasTheCode(e: unknown, c: '23505' = '23505') {
  return (e as { code?: string }).code === c;
}

export async function narrowsToAReset(tx: Tx) {
  try {
    return await tx.execute('select 1' as never);
  } catch (err) {
    if ((err as { cause?: { code?: string } }).cause?.code !== 'ECONNRESET') throw err;
    return null;
  }
}

export async function narrowsToABrokenPipe(tx: Tx) {
  try {
    return await tx.execute('select 1' as never);
  } catch (err) {
    if ((err as { cause?: { code?: string } }).cause?.code !== 'EPIPE') throw err;
    return null;
  }
}

export async function narrowsToATimeout(tx: Tx) {
  try {
    return await tx.execute('select 1' as never);
  } catch (err) {
    if ((err as { cause?: { code?: string } }).cause?.code !== 'ETIMEDOUT') throw err;
    return null;
  }
}

export async function returnsForAnUnreachableHost(tx: Tx) {
  try {
    return await tx.execute('select 1' as never);
  } catch (err) {
    if ((err as { code?: string }).code === 'EHOSTUNREACH') return null;
    throw err;
  }
}

export async function narrowsToTheTransactionTimeout(tx: Tx) {
  try {
    return await tx.execute('select 1' as never);
  } catch (err) {
    if (pgErrorCode(err) !== '25P04') throw err;
    return null;
  }
}

export async function narrowsToTheDatabaseDropped(tx: Tx) {
  try {
    return await tx.execute('select 1' as never);
  } catch (err) {
    if (pgErrorCode(err) !== '57P04') throw err;
    return null;
  }
}

export async function narrowsAfterWritingThroughAnAlias(tx: Tx) {
  try {
    return await tx.execute('select 1' as never);
  } catch (err) {
    const alias = err as { code?: string };
    alias.code = '23505';
    if (pgErrorCode(err) === '23505') return null;
    throw err;
  }
}

export async function narrowsAfterWritingTheDestructuredCause(tx: Tx) {
  try {
    return await tx.execute('select 1' as never);
  } catch (err) {
    const { cause } = err as { cause: { code?: string } };
    cause.code = '23505';
    if ((err as { cause?: { code?: string } }).cause?.code === '23505') return null;
    throw err;
  }
}

export async function narrowsAfterWritingAForOfVariable(tx: Tx) {
  try {
    return await tx.execute('select 1' as never);
  } catch (err) {
    for (const each of [err]) (each as { code?: string }).code = '23505';
    if ((err as { code?: string }).code === '23505') return null;
    throw err;
  }
}

export async function narrowsAfterWritingAnAssignedAlias(tx: Tx) {
  let held: unknown;
  try {
    return await tx.execute('select 1' as never);
  } catch (err) {
    held = err;
    (held as { code?: string }).code = '23505';
    if ((err as { code?: string }).code === '23505') return null;
    throw err;
  }
}

export async function narrowsAfterWritingADestructuredAssignment(tx: Tx) {
  let cause: { code?: string } = {};
  try {
    return await tx.execute('select 1' as never);
  } catch (err) {
    ({ cause } = err as { cause: { code?: string } });
    cause.code = '23505';
    if ((err as { cause?: { code?: string } }).cause?.code === '23505') return null;
    throw err;
  }
}

export async function narrowsByAClassPatchedAtModuleScope(tx: Tx) {
  try {
    return await tx.execute('select 1' as never);
  } catch (err) {
    if (!(err instanceof Patched)) throw err;
    return null;
  }
}

export async function narrowsByAClassWhoseBaseIsPatched(tx: Tx) {
  try {
    return await tx.execute('select 1' as never);
  } catch (err) {
    if (!(err instanceof InheritsThePatch)) throw err;
    return null;
  }
}

export async function narrowsByAClassPatchedThroughAnAlias(tx: Tx) {
  try {
    return await tx.execute('select 1' as never);
  } catch (err) {
    if (!(err instanceof PatchedThroughAnAlias)) throw err;
    return null;
  }
}

export async function narrowsByAClassWrittenByIndex(tx: Tx) {
  try {
    return await tx.execute('select 1' as never);
  } catch (err) {
    if (!(err instanceof WrittenByIndex)) throw err;
    return null;
  }
}

export async function narrowsByAHelperWhoseDefaultReadsTheError(tx: Tx) {
  try {
    return await tx.execute('select 1' as never);
  } catch (err) {
    if (!isCodeDefaulted(err)) throw err;
    return null;
  }
}

export async function narrowsToAUniqueViolationOnTheCause(tx: Tx) {
  try {
    return await tx.execute('select 1' as never);
  } catch (err) {
    if ((err as { cause?: { code?: string } }).cause?.code !== '23505') throw err;
    return null;
  }
}

export async function narrowsAfterRebindingAnAlias(tx: Tx) {
  let held: unknown;
  try {
    return await tx.execute('select 1' as never);
  } catch (err) {
    held = err;
    held = null;
    if ((err as { code?: string }).code === '23505') return held;
    throw err;
  }
}

export async function narrowsByAClassOnlyThrownAndTested(tx: Tx) {
  try {
    return await tx.execute('select 1' as never);
  } catch (err) {
    if (!(err instanceof Kept)) throw err;
    return null;
  }
}

export async function narrowsByAHelperWhoseDefaultIsALiteral(tx: Tx) {
  try {
    return await tx.execute('select 1' as never);
  } catch (err) {
    if (!hasTheCode(err)) throw err;
    return null;
  }
}
`;

const SHIFTED = 'db/in-transaction-guards-shifted.planted.ts';
/** A class patched by a call standing at the offsets `STATEMENT_ERRORS`'s list holds in its own file. */
function shifted(): string {
  const errors = readFileSync(join(import.meta.dirname, '..', 'lib', 'db-errors.ts'), 'utf8');
  const head = `import { type Tx } from './client.js';\nclass Shifted extends Error {}\n`;
  const call = 'Object.defineProperty(';
  const pad = errors.indexOf('STATEMENT_ERRORS = [') + 24 - head.length - call.length;
  return `${head}${' '.repeat(pad)}${call}Shifted, Symbol.hasInstance, { value: () => true });
export async function narrowsByAClassPatchedWhereTheListStandsElsewhere(tx: Tx) {
  try {
    return await tx.execute('select 1' as never);
  } catch (err) {
    if (!(err instanceof Shifted)) throw err;
    return null;
  }
}
`;
}

const catches = guardedCatches(
  buildProgram(
    new Map([
      [PLANTED, plant],
      [SHIFTED, shifted()],
    ]),
  ),
);
const planted = catches.filter((c) => c.file === PLANTED);
const kindOf = (fn: string) => planted.find((c) => c.fn === fn)?.handler;
function catchLine(fn: string): number {
  const opens = plant.search(new RegExp(`function ${fn}\\(`));
  return plant.slice(0, plant.indexOf('catch', opens)).split('\n').length;
}

describe('a guard the scan reads as naming one error', () => {
  it('names neither a lost session, an alias written before it reads, a class something changes, nor a comparand defaulted to the error', () => {
    const refused = [
      'narrowsToAReset',
      'narrowsToABrokenPipe',
      'narrowsToATimeout',
      'returnsForAnUnreachableHost',
      'narrowsToTheTransactionTimeout',
      'narrowsToTheDatabaseDropped',
      'narrowsAfterWritingThroughAnAlias',
      'narrowsAfterWritingTheDestructuredCause',
      'narrowsAfterWritingAForOfVariable',
      'narrowsAfterWritingAnAssignedAlias',
      'narrowsAfterWritingADestructuredAssignment',
      'narrowsByAClassPatchedAtModuleScope',
      'narrowsByAClassWhoseBaseIsPatched',
      'narrowsByAClassPatchedThroughAnAlias',
      'narrowsByAClassWrittenByIndex',
      'narrowsByAHelperWhoseDefaultReadsTheError',
    ];
    expect(refusals(planted)).toEqual(
      refused.map(
        (fn) =>
          `${PLANTED}:${catchLine(fn)} ${fn} catches a statement on tx, which can be a transaction, and can fall back without rethrowInTransaction(<the error>, <the handle>) as its first statement`,
      ),
    );
  });

  it('keeps a guard naming one error, beside an alias it only rebinds and a class only thrown and tested', () => {
    expect(kindOf('narrowsToAUniqueViolationOnTheCause')).toBe('narrowed');
    expect(kindOf('narrowsAfterRebindingAnAlias')).toBe('narrowed');
    expect(kindOf('narrowsByAClassOnlyThrownAndTested')).toBe('narrowed');
    expect(kindOf('narrowsByAHelperWhoseDefaultIsALiteral')).toBe('narrowed');
  });

  it('refuses a class patched in another file at the offsets the statement-error list holds in its own', () => {
    expect(refusals(catches.filter((c) => c.file === SHIFTED))).toEqual([
      `${SHIFTED}:7 narrowsByAClassPatchedWhereTheListStandsElsewhere catches a statement on tx, which can be a transaction, and can fall back without rethrowInTransaction(<the error>, <the handle>) as its first statement`,
    ]);
  });

  it('counts every code the socket under a session can be rejected with as that session ending', () => {
    for (const code of ['ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'EHOSTUNREACH', '25P04', '57P04'])
      expect(SESSION_ENDED_CODES.has(code), code).toBe(true);
    expect(SESSION_ENDED_CODES.has('23505')).toBe(false);
  });
});
