import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SESSION_ENDED_CODES } from '../lib/db-errors.js';
import { buildProgram, guardedCatches, refusals } from './in-transaction-catches.fixture.js';

const PLANTED = 'db/in-transaction-guards.planted.ts';

const plant = `import { mkdir, open, readFile } from 'node:fs/promises';
import { DrizzleQueryError } from 'drizzle-orm/errors';
import { type Tx } from './client.js';
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

class Reparented extends Error {}
Object.setPrototypeOf(DrizzleQueryError.prototype, Reparented.prototype);

class Recoded extends Error {}
(Recoded.prototype as unknown as { code: string }).code = '23505';

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

export async function narrowsByAClassAStatementErrorWasReparentedTo(tx: Tx) {
  try {
    return await tx.execute('select 1' as never);
  } catch (err) {
    if (!(err instanceof Reparented)) throw err;
    return null;
  }
}

export async function narrowsByAClassWhosePrototypeWasWritten(tx: Tx) {
  try {
    return await tx.execute('select 1' as never);
  } catch (err) {
    if (!(err instanceof Recoded)) throw err;
    return null;
  }
}

export async function narrowsAfterWritingThePrototypeOfTheError(tx: Tx) {
  try {
    return await tx.execute('select 1' as never);
  } catch (err) {
    (Object.getPrototypeOf(err) as { code?: string }).code = '23505';
    if ((err as { code?: string }).code === '23505') return null;
    throw err;
  }
}

export async function narrowsAfterWritingThroughACallResult(tx: Tx) {
  try {
    return await tx.execute('select 1' as never);
  } catch (err) {
    const get = () => err as { code?: string };
    get().code = '23505';
    if ((err as { code?: string }).code === '23505') return null;
    throw err;
  }
}

export async function narrowsAfterWritingThroughADeclaredFunctionsResult(tx: Tx) {
  try {
    return await tx.execute('select 1' as never);
  } catch (err) {
    function get() {
      return err as { code?: string };
    }
    get().code = '23505';
    if ((err as { code?: string }).code === '23505') return null;
    throw err;
  }
}

export async function narrowsAfterWritingThroughAMapEntry(tx: Tx) {
  try {
    return await tx.execute('select 1' as never);
  } catch (err) {
    const held = new Map([[0, err as { code?: string }]]);
    (held.get(0) as { code?: string }).code = '23505';
    if ((err as { code?: string }).code === '23505') return null;
    throw err;
  }
}

export async function narrowsAfterWritingThroughADefaultedParameter(tx: Tx) {
  try {
    return await tx.execute('select 1' as never);
  } catch (err) {
    const recode = (e = err as { code?: string }) => {
      e.code = '23505';
    };
    recode();
    if ((err as { code?: string }).code === '23505') return null;
    throw err;
  }
}

export async function narrowsAfterWritingThroughADefaultedBinding(tx: Tx) {
  try {
    return await tx.execute('select 1' as never);
  } catch (err) {
    const { e = err as { code?: string } } = {} as { e?: { code?: string } };
    e.code = '23505';
    if ((err as { code?: string }).code === '23505') return null;
    throw err;
  }
}

const box: { error?: { code?: string } } = {};
const getBox = () => box;

export async function narrowsAfterWritingThroughAHolderACallReturns(tx: Tx) {
  try {
    return await tx.execute('select 1' as never);
  } catch (err) {
    getBox().error = err as { code?: string };
    const again = getBox();
    (again.error as { code?: string }).code = '23505';
    if ((err as { code?: string }).code === '23505') return null;
    throw err;
  }
}

export class Retrier {
  last: { code?: string } | undefined;

  async narrowsAfterWritingThroughThis(tx: Tx) {
    try {
      return await tx.execute('select 1' as never);
    } catch (err) {
      this.last = err as { code?: string };
      this.last.code = '23505';
      if ((err as { code?: string }).code === '23505') return null;
      throw err;
    }
  }
}

export async function returnsWhenTheSeedFileIsMissing(tx: Tx) {
  try {
    const seed = await readFile('/srv/seed.sql', 'utf8');
    return await tx.execute(seed as never);
  } catch (err) {
    if ((err as { code?: string }).code !== 'ENOENT') throw err;
    return null;
  }
}

export async function returnsWhenTheDirectoryExists(tx: Tx) {
  try {
    await mkdir('/srv/exports');
    return await tx.execute('select 1' as never);
  } catch (err) {
    if ((err as { code?: string }).code !== 'EEXIST') throw err;
    return null;
  }
}

export async function returnsWhenTheFileIsDenied(tx: Tx) {
  try {
    await (await open('/srv/report.csv', 'w')).close();
    return await tx.execute('select 1' as never);
  } catch (err) {
    if ((err as { code?: string }).code === 'EACCES') return null;
    throw err;
  }
}

export async function narrowsAfterTheErrorIsOnlyLoggedAndCounted(tx: Tx) {
  const seen = new Map<string, { count: number }>([['x', { count: 0 }]]);
  try {
    return await tx.execute('select 1' as never);
  } catch (err) {
    (seen.get(String((err as Error).message)) as { count: number }).count += 1;
    if ((err as { code?: string }).code === '23505') return null;
    throw err;
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

const WRITES = 'db/in-transaction-writes.planted.ts';
/** A catch that does `use` with the error, then goes on for one code only. */
const poisoned = (fn: string, use: string) => `
export async function ${fn}(tx: Tx) {
  try {
    return await tx.execute('select 1' as never);
  } catch (err) {
    ${use}
    if (pgErrorCode(err) === '23505') return null;
    throw err;
  }
}
`;
const coded = '{ code?: string }';
/** Uses of the caught error before its guard reads it, each shaped so the guard reads a code it was handed. */
const writes = `import { type Tx } from './client.js';
import { isUniqueViolation, pgErrorCode } from '../lib/db-errors.js';

declare const flag: boolean;
class Wrapped extends Error {}
class Trap {
  set e(v: unknown) {
    (v as ${coded}).code = '23505';
  }
}
${poisoned('refusesAWriteThroughAnAwait', `(await Promise.resolve(err as ${coded})).code = '23505';`)}
${poisoned('refusesAWriteThroughAComma', `((0, err) as ${coded}).code = '23505';`)}
${poisoned('refusesAWriteThroughAConditional', `((flag ? err : err) as ${coded}).code = '23505';`)}
${poisoned('refusesAWriteThroughANullishDefault', `((err ?? {}) as ${coded}).code = '23505';`)}
${poisoned('refusesAWriteThroughAnOr', `((err || {}) as ${coded}).code = '23505';`)}
${poisoned('refusesACallbackHandedTheError', `[err as ${coded}].forEach((e) => { e.code = '23505'; });`)}
${poisoned('refusesAnImmediateCallHandedTheError', `((e: ${coded}) => { e.code = '23505'; })(err as ${coded});`)}
${poisoned('refusesAPropertyDefinedOnTheError', "Object.defineProperty(err, 'code', { value: '23505' });")}
${poisoned('refusesAReflectedSet', "Reflect.set(err as object, 'code', '23505');")}
${poisoned('refusesAWriteToThePrototypeOfTheError', "Object.setPrototypeOf(Object.getPrototypeOf(err), { code: '23505' });")}
${poisoned('refusesAnAssignOntoTheError', "Object.assign(err as object, { code: '23505' });")}
${poisoned('refusesAWriteThroughAMapItWasSetIn', `const m = new Map<number, ${coded}>(); m.set(0, err as ${coded}); m.get(0)!.code = '23505';`)}
${poisoned('refusesAWriteThroughAShorthandHolder', `const e = err as ${coded}; const held = { e }; held.e.code = '23505';`)}
${poisoned('refusesAUseItCannotRead', 'const seen = String(err);')}
${poisoned('refusesAStoreIntoASetter', 'const box = new Trap(); box.e = err;')}

export async function refusesAUseBeforeAnExitItDecidesAt(tx: Tx) {
  try {
    return await tx.execute('select 1' as never);
  } catch (err) {
    if (isUniqueViolation(err)) {
      console.warn(err);
      return null;
    }
    throw err;
  }
}

export class Poisoner {
  last: ${coded} | undefined;
  poison() {
    if (this.last) this.last.code = '23505';
  }
  async refusesAMethodCalledOnAHolder(tx: Tx) {
    try {
      return await tx.execute('select 1' as never);
    } catch (err) {
      this.last = err as ${coded};
      this.poison();
      if (pgErrorCode(err) === '23505') return null;
      throw err;
    }
  }
}

export async function keepsAUseAfterItsOpeningGuard(tx: Tx) {
  try {
    return await tx.execute('select 1' as never);
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    console.warn(err);
    return null;
  }
}

export async function keepsAnErrorItAlwaysThrowsWrapped(tx: Tx) {
  try {
    return await tx.execute('select 1' as never);
  } catch (err) {
    throw new Wrapped(String(err), { cause: err });
  }
}

${poisoned('keepsAStoreReadsAndADiscardedComma', `const box: { e?: unknown; n?: number } = {}; box.e = err; box.n = (err, 1); const message = (err as Error).message; if (typeof err === 'object' && !err && message) throw err;`)}
`;

const catches = guardedCatches(
  buildProgram(
    new Map([
      [PLANTED, plant],
      [SHIFTED, shifted()],
      [WRITES, writes],
    ]),
  ),
);
const planted = catches.filter((c) => c.file === PLANTED);
const kindOf = (fn: string) => planted.find((c) => c.fn === fn)?.handler;
function catchLine(fn: string): number {
  const opens = plant.search(new RegExp(`(?:function |async )${fn}\\(`));
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
      'narrowsByAClassAStatementErrorWasReparentedTo',
      'narrowsByAClassWhosePrototypeWasWritten',
      'narrowsAfterWritingThePrototypeOfTheError',
      'narrowsAfterWritingThroughACallResult',
      'narrowsAfterWritingThroughADeclaredFunctionsResult',
      'narrowsAfterWritingThroughAMapEntry',
      'narrowsAfterWritingThroughADefaultedParameter',
      'narrowsAfterWritingThroughADefaultedBinding',
      'narrowsAfterWritingThroughAHolderACallReturns',
      'narrowsAfterWritingThroughThis',
    ];
    expect(refusals(planted)).toEqual(
      refused.map(
        (fn) =>
          `${PLANTED}:${catchLine(fn)} ${fn} catches a statement on tx, which can be a transaction, and can fall back for an error it does not name: guard on the one error it means, move what is not a statement out of the try and catch that apart, start the catch with rethrowInTransaction(<the error>, <the handle>) where it must not fall back, or give it an EXCEPTIONS entry with its reason`,
      ),
    );
  });

  it('keeps a guard naming one error, beside an alias it only rebinds and a class only thrown and tested', () => {
    expect(kindOf('narrowsToAUniqueViolationOnTheCause')).toBe('narrowed');
    expect(kindOf('narrowsAfterRebindingAnAlias')).toBe('narrowed');
    expect(kindOf('narrowsByAClassOnlyThrownAndTested')).toBe('narrowed');
    expect(kindOf('narrowsByAHelperWhoseDefaultIsALiteral')).toBe('narrowed');
    expect(kindOf('narrowsAfterTheErrorIsOnlyLoggedAndCounted')).toBe('narrowed');
  });

  it('keeps a guard on a code a file call raises, which no statement error carries', () => {
    expect(kindOf('returnsWhenTheSeedFileIsMissing')).toBe('narrowed');
    expect(kindOf('returnsWhenTheDirectoryExists')).toBe('narrowed');
    expect(kindOf('returnsWhenTheFileIsDenied')).toBe('narrowed');
  });

  it('refuses a class patched in another file at the offsets the statement-error list holds in its own', () => {
    expect(refusals(catches.filter((c) => c.file === SHIFTED))).toEqual([
      `${SHIFTED}:7 narrowsByAClassPatchedWhereTheListStandsElsewhere catches a statement on tx, which can be a transaction, and can fall back for an error it does not name: guard on the one error it means, move what is not a statement out of the try and catch that apart, start the catch with rethrowInTransaction(<the error>, <the handle>) where it must not fall back, or give it an EXCEPTIONS entry with its reason`,
    ]);
  });

  it('counts every code the socket under a session can be rejected with as that session ending', () => {
    for (const code of ['ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'EHOSTUNREACH', '25P04', '57P04'])
      expect(SESSION_ENDED_CODES.has(code), code).toBe(true);
  });

  it('counts no code an open socket never fails with, as a connect or a file call raises or a statement carries', () => {
    for (const code of ['ENOENT', 'EEXIST', 'EACCES', 'ECONNREFUSED', 'EMFILE', '23505'])
      expect(SESSION_ENDED_CODES.has(code), code).toBe(false);
    for (const code of ['CONNECT_TIMEOUT', '08001', '08004', '57P03'])
      expect(SESSION_ENDED_CODES.has(code), code).toBe(false);
  });
});

describe('a use of the caught error before its guard reads it', () => {
  const kind = (fn: string) => catches.find((c) => c.file === WRITES && c.fn === fn)?.handler;
  const line = (fn: string) => {
    const opens = writes.search(new RegExp(`(?:function |async )${fn}\\(`));
    return writes.slice(0, writes.indexOf('catch', opens)).split('\n').length;
  };

  it('refuses every use it cannot resolve as a plain read, naming its file, line and function', () => {
    const refused = [
      'refusesAWriteThroughAnAwait',
      'refusesAWriteThroughAComma',
      'refusesAWriteThroughAConditional',
      'refusesAWriteThroughANullishDefault',
      'refusesAWriteThroughAnOr',
      'refusesACallbackHandedTheError',
      'refusesAnImmediateCallHandedTheError',
      'refusesAPropertyDefinedOnTheError',
      'refusesAReflectedSet',
      'refusesAWriteToThePrototypeOfTheError',
      'refusesAnAssignOntoTheError',
      'refusesAWriteThroughAMapItWasSetIn',
      'refusesAWriteThroughAShorthandHolder',
      'refusesAUseItCannotRead',
      'refusesAStoreIntoASetter',
      'refusesAUseBeforeAnExitItDecidesAt',
      'refusesAMethodCalledOnAHolder',
    ];
    expect(refusals(catches.filter((c) => c.file === WRITES))).toEqual(
      refused.map(
        (fn) =>
          `${WRITES}:${line(fn)} ${fn} catches a statement on tx, which can be a transaction, and can fall back for an error it does not name: guard on the one error it means, move what is not a statement out of the try and catch that apart, start the catch with rethrowInTransaction(<the error>, <the handle>) where it must not fall back, or give it an EXCEPTIONS entry with its reason`,
      ),
    );
  });

  it('keeps a use after an opening guard, an error it always throws, a store, a read and a discarded comma', () => {
    expect(kind('keepsAUseAfterItsOpeningGuard')).toBe('narrowed');
    expect(kind('keepsAnErrorItAlwaysThrowsWrapped')).toBe('narrowed');
    expect(kind('keepsAStoreReadsAndADiscardedComma')).toBe('narrowed');
  });
});
