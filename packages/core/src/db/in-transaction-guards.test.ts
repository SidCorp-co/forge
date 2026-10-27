import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SESSION_ENDED_CODES } from '../lib/db-errors.js';
import { buildProgram, guardedCatches, refusals } from './in-transaction-catches.fixture.js';

const PLANTED = 'db/in-transaction-guards.planted.ts';

const FALLS_BACK =
  'can fall back for an error it does not name: guard on the one error it means, move what is not a statement out of the try and catch that apart, start the catch with rethrowInTransaction(<the error>, <the handle>) where it must not fall back';
const AFTER_THE_GUARD =
  'open the catch with if (!<names the one error>) throw <the error>; and do it after that, where only that error reaches';
const usesTheError = (line: number, text: string) =>
  `uses the error at line ${line} in \`${text}\`, which the scan cannot read as a plain read, on a path an error it does not name can take, where the error goes on to its guard or up to the catch around it: there use it only by a comparison, instanceof, typeof, a property read down to a primitive, a lib/db-errors.ts reader or isX helper, a store to a key no guard reads, or a throw of it unchanged; or ${AFTER_THE_GUARD}`;
const replacesTheError = (line: number, text: string) =>
  `throws at line ${line} \`${text}\` in place of an error it does not name, which a catch around it can mistake for the one it names: throw the error it caught unchanged there, start the catch with rethrowInTransaction(<the error>, <the handle>) where a replacement must not reach a transaction, or ${AFTER_THE_GUARD}`;

/** The line `text` first stands on in `source` after `fn` opens. */
function lineIn(source: string, fn: string, text: string): number {
  const opens = source.search(new RegExp(`(?:function |async )${fn}\\(`));
  const at = source.indexOf(text, opens);
  if (opens === -1 || at === -1) throw new Error(`${fn} holds no \`${text}\``);
  return source.slice(0, at).split('\n').length;
}

/**
 * The refusal of `fn`'s first catch in `file`, whose text is `source`: for the use or the throw
 * whose text `why` names, at the line that text first stands on after `fn` opens, or a fall-back.
 */
function refusalOf(
  file: string,
  source: string,
  fn: string,
  why: { use: string } | { throws: string } | undefined,
): string {
  const lineOf = (text: string) => lineIn(source, fn, text);
  const reason =
    why === undefined
      ? FALLS_BACK
      : 'use' in why
        ? usesTheError(lineOf(why.use), why.use)
        : replacesTheError(lineOf(why.throws), why.throws);
  return `${file}:${lineOf('catch')} ${fn} catches a statement on tx, which can be a transaction, and ${reason}, or give it an EXCEPTIONS entry with its reason`;
}

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

export async function narrowsByAComparandBoundFromTheError(tx: Tx) {
  try {
    return await tx.execute('select 1' as never);
  } catch (err) {
    const known = (err as { code: '23505' }).code;
    if ((err as { code?: string }).code !== known) throw err;
    return null;
  }
}

export async function narrowsByAComparandDestructuredFromTheError(tx: Tx) {
  try {
    return await tx.execute('select 1' as never);
  } catch (err) {
    const { code: known } = err as { code: '23505' };
    if ((err as { code?: string }).code !== known) throw err;
    return null;
  }
}

export async function narrowsByAComparandAssignedFromTheError(tx: Tx) {
  try {
    return await tx.execute('select 1' as never);
  } catch (err) {
    let known: '23505' = '23505';
    known = (err as { code: '23505' }).code;
    if ((err as { code?: string }).code !== known) throw err;
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
declare const log: { warn(o: object, m: string): void; error(o: object, m: string): void };
class Wrapped extends Error {}
class Conflict extends Error {}
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
${poisoned('refusesADirectEval', `eval("err.code = '23505'");`)}

export function refusesArgumentsInAFunctionHandler(tx: Tx) {
  return tx.execute('select 1' as never).catch(function (err: unknown) {
    (arguments[0] as ${coded}).code = '23505';
    if (pgErrorCode(err) === '23505') return null;
    throw err;
  });
}

export async function rewritesWhatItRethrows(tx: Tx) {
  try {
    try {
      return await tx.execute('select 1' as never);
    } catch (e) {
      (e as ${coded}).code = '23505';
      throw e;
    }
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    return null;
  }
}

export async function rewritesOnTheBranchItRethrows(tx: Tx) {
  try {
    try {
      return await tx.execute('select 1' as never);
    } catch (e) {
      if (!isUniqueViolation(e)) {
        (e as ${coded}).code = '23505';
        throw e;
      }
      return null;
    }
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    return null;
  }
}

export async function translatesEveryErrorToItsOwnClass(tx: Tx) {
  try {
    try {
      return await tx.execute('select 1' as never);
    } catch (e) {
      throw new Conflict('exists', { cause: e });
    }
  } catch (err) {
    if (!(err instanceof Conflict)) throw err;
    return null;
  }
}

export async function annotatesTheCauseItRethrows(tx: Tx) {
  try {
    return await tx.execute('select 1' as never);
  } catch (e) {
    (e as { cause?: unknown }).cause = { code: '23505' };
    throw e;
  }
}

export async function swapsTheClassOfWhatItRethrows(tx: Tx) {
  try {
    return await tx.execute('select 1' as never);
  } catch (e) {
    (e as { __proto__?: object }).__proto__ = {};
    throw e;
  }
}

export async function logsBeforeDeciding(tx: Tx) {
  try {
    return await tx.execute('select 1' as never);
  } catch (err) {
    log.warn({ err }, 'insert failed');
    if (isUniqueViolation(err)) return null;
    throw err;
  }
}

export async function logsOnTheRethrow(tx: Tx) {
  try {
    return await tx.execute('select 1' as never);
  } catch (err) {
    if (isUniqueViolation(err)) return null;
    log.error({ err }, 'insert failed');
    throw err;
  }
}

export async function wrapsOnTheRethrow(tx: Tx) {
  try {
    return await tx.execute('select 1' as never);
  } catch (err) {
    if (isUniqueViolation(err)) return null;
    throw new Error('insert failed', { cause: err });
  }
}

export async function refusesAWrapItAlwaysThrows(tx: Tx) {
  try {
    return await tx.execute('select 1' as never);
  } catch (err) {
    throw new Wrapped(String(err), { cause: err });
  }
}

export async function refusesAHelperItRunsOnTheRethrow(tx: Tx) {
  try {
    return await tx.execute('select 1' as never);
  } catch (err) {
    const fail = (): void => {
      throw new Error('insert failed');
    };
    if (isUniqueViolation(err)) return null;
    fail();
    throw err;
  }
}

export async function refusesAReplacementItRunsAtOnce(tx: Tx) {
  try {
    return await tx.execute('select 1' as never);
  } catch (err) {
    if (isUniqueViolation(err)) return null;
    (() => {
      throw new Error('insert failed');
    })();
    throw err;
  }
}

export async function refusesAHelperItRunsThroughAnotherName(tx: Tx) {
  try {
    try {
      return await tx.execute('select 1' as never);
    } catch (err) {
      function fail(): void {
        throw new Conflict('exists');
      }
      const run = fail;
      run();
      throw err;
    }
  } catch (err) {
    if (!(err instanceof Conflict)) throw err;
    return null;
  }
}

export async function keepsAHelperItRunsAfterItsGuard(tx: Tx) {
  try {
    return await tx.execute('select 1' as never);
  } catch (err) {
    function fail(): never {
      throw new Error('a duplicate, named');
    }
    if (!isUniqueViolation(err)) throw err;
    fail();
  }
}

export async function annotatesWhatItRethrows(tx: Tx) {
  try {
    return await tx.execute('select 1' as never);
  } catch (e) {
    (e as { context?: string }).context = 'inserting the row';
    throw e;
  }
}

export async function keepsAUseOnTheBranchItNamed(tx: Tx) {
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

describe('a guard the scan reads as naming one error', () => {
  it('names neither a lost session, an alias written before it reads, a class something changes, nor a comparand defaulted to or bound from the error', () => {
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
      'narrowsByAComparandBoundFromTheError',
      'narrowsByAComparandDestructuredFromTheError',
      'narrowsByAComparandAssignedFromTheError',
    ];
    const used: Record<string, string> = {
      narrowsAfterWritingThroughAnAlias: "alias.code = '23505'",
      narrowsAfterWritingTheDestructuredCause: "cause.code = '23505'",
      narrowsAfterWritingAForOfVariable: '[err]',
      narrowsAfterWritingAnAssignedAlias: "(held as { code?: string }).code = '23505'",
      narrowsAfterWritingADestructuredAssignment: "cause.code = '23505'",
      narrowsAfterWritingThePrototypeOfTheError:
        "(Object.getPrototypeOf(err) as { code?: string }).code = '23505'",
      narrowsAfterWritingThroughACallResult: "get().code = '23505'",
      narrowsAfterWritingThroughADeclaredFunctionsResult: "get().code = '23505'",
      narrowsAfterWritingThroughAMapEntry: 'const held = new Map([[0, err as { code?: string }]])',
      narrowsAfterWritingThroughADefaultedParameter: "e.code = '23505'",
      narrowsAfterWritingThroughADefaultedBinding: "e.code = '23505'",
      narrowsAfterWritingThroughAHolderACallReturns: 'getBox().error = err as { code?: string }',
      narrowsAfterWritingThroughThis: "this.last.code = '23505'",
    };
    expect(refusals(planted)).toEqual(
      refused.map((fn) => {
        const use = used[fn];
        return refusalOf(PLANTED, plant, fn, use === undefined ? undefined : { use });
      }),
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
      `${SHIFTED}:7 narrowsByAClassPatchedWhereTheListStandsElsewhere catches a statement on tx, which can be a transaction, and ${FALLS_BACK}, or give it an EXCEPTIONS entry with its reason`,
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

describe('a use of the caught error on a path an error it does not name can take', () => {
  const kinds = (fn: string) =>
    catches.filter((c) => c.file === WRITES && c.fn === fn).map((c) => c.handler);

  it('refuses each use it cannot read as a plain read, or a replacement it throws, naming which and where', () => {
    const coded = "(e as { code?: string }).code = '23505'";
    const refused: Array<[string, { use: string } | { throws: string }]> = [
      [
        'refusesAWriteThroughAnAwait',
        { use: "(await Promise.resolve(err as { code?: string })).code = '23505'" },
      ],
      ['refusesAWriteThroughAComma', { use: "((0, err) as { code?: string }).code = '23505'" }],
      [
        'refusesAWriteThroughAConditional',
        { use: "((flag ? err : err) as { code?: string }).code = '23505'" },
      ],
      [
        'refusesAWriteThroughANullishDefault',
        { use: "((err ?? {}) as { code?: string }).code = '23505'" },
      ],
      ['refusesAWriteThroughAnOr', { use: "((err || {}) as { code?: string }).code = '23505'" }],
      [
        'refusesACallbackHandedTheError',
        { use: "[err as { code?: string }].forEach((e) => { e.code = '23505'; })" },
      ],
      [
        'refusesAnImmediateCallHandedTheError',
        { use: "((e: { code?: string }) => { e.code = '23505'; })(err as { code?: string })" },
      ],
      [
        'refusesAPropertyDefinedOnTheError',
        { use: "Object.defineProperty(err, 'code', { value: '23505' })" },
      ],
      ['refusesAReflectedSet', { use: "Reflect.set(err as object, 'code', '23505')" }],
      [
        'refusesAWriteToThePrototypeOfTheError',
        { use: "Object.setPrototypeOf(Object.getPrototypeOf(err), { code: '23505' })" },
      ],
      ['refusesAnAssignOntoTheError', { use: "Object.assign(err as object, { code: '23505' })" }],
      ['refusesAWriteThroughAMapItWasSetIn', { use: 'm.set(0, err as { code?: string })' }],
      ['refusesAWriteThroughAShorthandHolder', { use: "held.e.code = '23505'" }],
      ['refusesAUseItCannotRead', { use: 'const seen = String(err)' }],
      ['refusesAStoreIntoASetter', { use: 'box.e = err' }],
      ['refusesADirectEval', { use: `eval("err.code = '23505'")` }],
      [
        'refusesArgumentsInAFunctionHandler',
        { use: "(arguments[0] as { code?: string }).code = '23505'" },
      ],
      ['rewritesWhatItRethrows', { use: coded }],
      ['rewritesOnTheBranchItRethrows', { use: coded }],
      [
        'translatesEveryErrorToItsOwnClass',
        { throws: "throw new Conflict('exists', { cause: e })" },
      ],
      [
        'annotatesTheCauseItRethrows',
        { use: "(e as { cause?: unknown }).cause = { code: '23505' }" },
      ],
      ['swapsTheClassOfWhatItRethrows', { use: '(e as { __proto__?: object }).__proto__ = {}' }],
      ['logsBeforeDeciding', { use: "log.warn({ err }, 'insert failed')" }],
      ['logsOnTheRethrow', { use: "log.error({ err }, 'insert failed')" }],
      ['wrapsOnTheRethrow', { throws: "throw new Error('insert failed', { cause: err })" }],
      ['refusesAWrapItAlwaysThrows', { throws: 'throw new Wrapped(String(err), { cause: err })' }],
      ['refusesAHelperItRunsOnTheRethrow', { throws: "throw new Error('insert failed')" }],
      ['refusesAReplacementItRunsAtOnce', { throws: "throw new Error('insert failed')" }],
      ['refusesAHelperItRunsThroughAnotherName', { throws: "throw new Conflict('exists')" }],
      ['refusesAMethodCalledOnAHolder', { use: 'this.poison()' }],
    ];
    expect(refusals(catches.filter((c) => c.file === WRITES))).toEqual(
      refused.map(([fn, why]) => refusalOf(WRITES, writes, fn, why)),
    );
  });

  it("keeps the outer catch around an inner one it refuses, since what reaches the outer is the inner's to answer", () => {
    expect(kinds('rewritesWhatItRethrows')).toEqual(['narrowed', 'swallows']);
    expect(kinds('rewritesOnTheBranchItRethrows')).toEqual(['narrowed', 'swallows']);
    expect(kinds('translatesEveryErrorToItsOwnClass')).toEqual(['narrowed', 'swallows']);
    expect(kinds('refusesAHelperItRunsThroughAnotherName')).toEqual(['narrowed', 'swallows']);
  });

  it('keeps a use after its opening guard or on a branch it named, a helper run only there, a store to a key no guard reads, a read and a discarded comma', () => {
    expect(kinds('keepsAUseAfterItsOpeningGuard')).toEqual(['narrowed']);
    expect(kinds('keepsAUseOnTheBranchItNamed')).toEqual(['narrowed']);
    expect(kinds('annotatesWhatItRethrows')).toEqual(['narrowed']);
    expect(kinds('keepsAHelperItRunsAfterItsGuard')).toEqual(['narrowed']);
    expect(kinds('keepsAStoreReadsAndADiscardedComma')).toEqual(['narrowed']);
  });

  it('says which use or throw it refused, at which line, and the way past it', () => {
    const said = refusals(catches.filter((c) => c.file === WRITES));
    const logs = (text: string) => lineIn(writes, 'logsOnTheRethrow', text);
    const wraps = (text: string) => lineIn(writes, 'wrapsOnTheRethrow', text);
    expect(said).toContain(
      `${WRITES}:${logs('catch')} logsOnTheRethrow catches a statement on tx, which can be a transaction, and uses the error at line ${logs('log.error')} in \`log.error({ err }, 'insert failed')\`, which the scan cannot read as a plain read, on a path an error it does not name can take, where the error goes on to its guard or up to the catch around it: there use it only by a comparison, instanceof, typeof, a property read down to a primitive, a lib/db-errors.ts reader or isX helper, a store to a key no guard reads, or a throw of it unchanged; or open the catch with if (!<names the one error>) throw <the error>; and do it after that, where only that error reaches, or give it an EXCEPTIONS entry with its reason`,
    );
    expect(said).toContain(
      `${WRITES}:${wraps('catch')} wrapsOnTheRethrow catches a statement on tx, which can be a transaction, and throws at line ${wraps('throw new')} \`throw new Error('insert failed', { cause: err })\` in place of an error it does not name, which a catch around it can mistake for the one it names: throw the error it caught unchanged there, start the catch with rethrowInTransaction(<the error>, <the handle>) where a replacement must not reach a transaction, or open the catch with if (!<names the one error>) throw <the error>; and do it after that, where only that error reaches, or give it an EXCEPTIONS entry with its reason`,
    );
  });
});
