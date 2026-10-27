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

const plant = `import { DrizzleError, DrizzleQueryError } from 'drizzle-orm/errors';
import postgres from 'postgres';
import { db, type Db, type Tx } from './client.js';
import { rethrowInTransaction } from './in-transaction.js';
import { pgConstraintName, pgErrorCode, UNIQUE_VIOLATION } from '../lib/db-errors.js';

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

/** Holds of every object, read by its body. */
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/**
 * Each below has a body of more than one statement, which the scan does not read, so each is refused
 * whatever its predicate says: nothing checks a predicate at run time.
 */
function isObjectLike(v: unknown): v is Record<string, unknown> {
  const kind = typeof v;
  return kind === 'object' && v !== null;
}

function isErrno(err: unknown): err is NodeJS.ErrnoException {
  const seen = err instanceof Error;
  return seen;
}

function hasMessage(err: unknown): err is { message: string } {
  const message = (err as { message?: unknown }).message;
  return typeof message === 'string';
}

function hasCode(err: unknown): err is { code?: string } {
  const code = (err as { code?: unknown }).code;
  return code !== undefined;
}

function isServerError(err: unknown): err is postgres.PostgresError {
  const name = (err as { name?: unknown }).name;
  return name === 'PostgresError';
}

function isRecordedError(err: unknown): err is Error & Record<string, unknown> {
  const seen = err instanceof Error;
  return seen;
}

/** Names one error by its predicate alone, which is not read. */
function isUniqueViolation(err: unknown): err is postgres.PostgresError & { code: '23505' } {
  const code = (err as { code?: unknown }).code;
  return code === '23505';
}

function isNamedError(err: unknown): err is Error & { name: 'Error' } {
  const seen = err instanceof Error;
  return seen;
}

function hasStack(err: unknown): err is { stack: string } {
  const stack = (err as { stack?: unknown }).stack;
  return typeof stack === 'string';
}

function isStackedError(err: unknown): err is Error & { stack: string } {
  const seen = err instanceof Error;
  return seen;
}

/** Names one error by its body, whatever its predicate says. */
function isCoded(err: unknown): err is { code: string } {
  return (err as { code?: string }).code === '23505';
}

/** Names one error, bound for good. */
const isConstRefusal = (err: unknown) => (err as { code?: string }).code === '23505';

/** Each below is bound where it can be replaced, so the body the scan reads may not be what runs. */
let isMutableRefusal = (err: unknown) => (err as { code?: string }).code === '23505';
isMutableRefusal = () => true;
const refusalGuards = { isRefusal: (err: unknown) => (err as { code?: string }).code === '23505' };
refusalGuards.isRefusal = () => true;
let readCode = pgErrorCode;
readCode = () => UNIQUE_VIOLATION;

/** Its comparand is a parameter typed as one code, which the caller can feed the error's own. */
function isCodeOf(err: unknown, code: '23505') {
  return (err as { code?: string }).code === code;
}

/** A class whose instanceof holds of everything, and one inheriting that. */
class AnyFailure {
  static [Symbol.hasInstance](_value: unknown) {
    return true;
  }
}
class AnyRefusal extends AnyFailure {}

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

export async function narrowsByARecordGuard(tx: Tx) {
  try {
    return await tx.execute('select 1' as never);
  } catch (err) {
    if (!isRecord(err)) throw err;
    return null;
  }
}

export async function narrowsByARecordPredicate(tx: Tx) {
  try {
    return await tx.execute('select 1' as never);
  } catch (err) {
    if (!isObjectLike(err)) throw err;
    return null;
  }
}

export async function narrowsByAnErrnoPredicate(tx: Tx) {
  try {
    return await tx.execute('select 1' as never);
  } catch (err) {
    if (!isErrno(err)) throw err;
    return null;
  }
}

export async function narrowsByAMessagePredicate(tx: Tx) {
  try {
    return await tx.execute('select 1' as never);
  } catch (err) {
    if (!hasMessage(err)) throw err;
    return null;
  }
}

export async function narrowsByAnOptionalPredicate(tx: Tx) {
  try {
    return await tx.execute('select 1' as never);
  } catch (err) {
    if (!hasCode(err)) throw err;
    return null;
  }
}

export async function narrowsToEveryServerError(tx: Tx) {
  try {
    return await tx.execute('select 1' as never);
  } catch (err) {
    if (!isServerError(err)) throw err;
    return null;
  }
}

export async function narrowsByAnIntersectionOfEvery(tx: Tx) {
  try {
    return await tx.execute('select 1' as never);
  } catch (err) {
    if (!isRecordedError(err)) throw err;
    return null;
  }
}

export async function narrowsByTheNameEveryErrorHas(tx: Tx) {
  try {
    return await tx.execute('select 1' as never);
  } catch (err) {
    if ((err as Error).name !== 'Error') throw err;
    return null;
  }
}

export async function narrowsByTheConstructorEveryErrorHas(tx: Tx) {
  try {
    return await tx.execute('select 1' as never);
  } catch (err) {
    if ((err as Error).constructor !== Error) throw err;
    return null;
  }
}

export async function narrowsByAUniqueViolationPredicate(tx: Tx) {
  try {
    return await tx.execute('select 1' as never);
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    return null;
  }
}

export async function narrowsByACodedBody(tx: Tx) {
  try {
    return await tx.execute('select 1' as never);
  } catch (err) {
    if (!isCoded(err)) throw err;
    return null;
  }
}

export async function narrowsByAServerErrorName(tx: Tx) {
  try {
    return await tx.execute('select 1' as never);
  } catch (err) {
    if ((err as Error).name !== 'PostgresError') throw err;
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

export async function narrowsByTheNameReadByIndex(tx: Tx) {
  try {
    return await tx.execute('select 1' as never);
  } catch (err) {
    if ((err as Error)['name'] !== 'Error') throw err;
    return null;
  }
}

export async function narrowsByTheNameOfErrorItself(tx: Tx) {
  try {
    return await tx.execute('select 1' as never);
  } catch (err) {
    if ((err as Error).name !== Error.name) throw err;
    return null;
  }
}

export async function narrowsByTheNameAsAString(tx: Tx) {
  try {
    return await tx.execute('select 1' as never);
  } catch (err) {
    if (String((err as Error).name) !== 'Error') throw err;
    return null;
  }
}

export async function narrowsByANamedErrorPredicate(tx: Tx) {
  try {
    return await tx.execute('select 1' as never);
  } catch (err) {
    if (!isNamedError(err)) throw err;
    return null;
  }
}

export async function narrowsByAStackPredicate(tx: Tx) {
  try {
    return await tx.execute('select 1' as never);
  } catch (err) {
    if (!hasStack(err)) throw err;
    return null;
  }
}

export async function narrowsByAStackedErrorPredicate(tx: Tx) {
  try {
    return await tx.execute('select 1' as never);
  } catch (err) {
    if (!isStackedError(err)) throw err;
    return null;
  }
}

export async function narrowsByTheSeverityEveryServerErrorHas(tx: Tx) {
  try {
    return await tx.execute('select 1' as never);
  } catch (err) {
    if ((err as postgres.PostgresError).severity !== 'ERROR') throw err;
    return null;
  }
}

export async function narrowsByAClassItCannotResolve(tx: Tx) {
  try {
    return await tx.execute('select 1' as never);
  } catch (err) {
    if (!(err instanceof (globalThis as any).Refusal)) throw err;
    return null;
  }
}

export async function narrowsByComparingTheErrorWithItself(tx: Tx) {
  try {
    return await tx.execute('select 1' as never);
  } catch (err) {
    if ((err as { code: '23505' }).code !== (err as { code: '23505' }).code) throw err;
    return null;
  }
}

export async function narrowsToTheDrizzleWrapper(tx: Tx) {
  try {
    return await tx.execute('select 1' as never);
  } catch (err) {
    if (!(err instanceof DrizzleQueryError)) throw err;
    return null;
  }
}

export async function narrowsToTheDrizzleBase(tx: Tx) {
  try {
    return await tx.execute('select 1' as never);
  } catch (err) {
    if (!(err instanceof DrizzleError)) throw err;
    return null;
  }
}

export async function narrowsToTheServerErrorOnTheCause(tx: Tx) {
  try {
    return await tx.execute('select 1' as never);
  } catch (err) {
    if (!((err as { cause?: unknown }).cause instanceof postgres.PostgresError)) throw err;
    return null;
  }
}

export async function narrowsToARewrappedCause(tx: Tx) {
  try {
    return await tx.execute('select 1' as never);
  } catch (err) {
    if (!((err as { cause?: unknown }).cause instanceof DrizzleQueryError)) throw err;
    return null;
  }
}

export async function narrowsByTheWrappersName(tx: Tx) {
  try {
    return await tx.execute('select 1' as never);
  } catch (err) {
    if ((err as Error).name !== 'DrizzleQueryError') throw err;
    return null;
  }
}

export async function narrowsToTheConnectionClosedOnTheCause(tx: Tx) {
  try {
    return await tx.execute('select 1' as never);
  } catch (err) {
    if ((err as { cause?: { code?: string } }).cause?.code !== 'CONNECTION_CLOSED') throw err;
    return null;
  }
}

export async function returnsForTheConnectionEnded(tx: Tx) {
  try {
    return await tx.execute('select 1' as never);
  } catch (err) {
    if ((err as { code?: string }).code === 'CONNECTION_ENDED') return null;
    throw err;
  }
}

export async function narrowsToTheServerShuttingDown(tx: Tx) {
  try {
    return await tx.execute('select 1' as never);
  } catch (err) {
    if (pgErrorCode(err) !== '57P01') throw err;
    return null;
  }
}

export async function returnsInsideTheRethrowBranch(tx: Tx) {
  try {
    return await tx.execute('select 1' as never);
  } catch (err) {
    if ((err as { code?: string }).code !== '23505') {
      if (tx) return null;
      throw err;
    }
    return null;
  }
}

export async function returnsBeforeTheRethrow(tx: Tx) {
  try {
    return await tx.execute('select 1' as never);
  } catch (err) {
    if ((err as { code?: string }).code !== '23505') {
      return null;
      throw err;
    }
    return null;
  }
}

export async function narrowsAfterReassigningTheError(tx: Tx) {
  try {
    return await tx.execute('select 1' as never);
  } catch (err) {
    err = { code: '23505' };
    if ((err as { code?: string }).code === '23505') return null;
    throw err;
  }
}

export async function narrowsAShadowOfTheError(tx: Tx) {
  try {
    return await tx.execute('select 1' as never);
  } catch (err) {
    {
      const err = { code: '23505' };
      if (err.code === '23505') return null;
    }
    throw err;
  }
}

export async function narrowsAfterWritingTheErrorsCode(tx: Tx) {
  try {
    return await tx.execute('select 1' as never);
  } catch (err) {
    (err as { cause?: { code?: string } }).cause = { code: '23505' };
    if ((err as { cause?: { code?: string } }).cause?.code !== '23505') throw err;
    return null;
  }
}

export async function narrowsAfterDestructuringIntoTheError(tx: Tx) {
  try {
    return await tx.execute('select 1' as never);
  } catch (err) {
    ({ found: err } = { found: { code: '23505' } });
    if ((err as { code?: string }).code !== '23505') throw err;
    return null;
  }
}

export async function narrowsThenIndexesByTheError(tx: Tx, seen: Record<string, boolean>) {
  try {
    return await tx.execute('select 1' as never);
  } catch (err) {
    if (!(err instanceof Refused)) throw err;
    seen[err.message] = true;
    return null;
  }
}

export async function narrowsByAClassThatHoldsOfAll(tx: Tx) {
  try {
    return await tx.execute('select 1' as never);
  } catch (err) {
    if (!(err instanceof AnyFailure)) throw err;
    return null;
  }
}

export async function narrowsByAClassInheritingThat(tx: Tx) {
  try {
    return await tx.execute('select 1' as never);
  } catch (err) {
    if (!(err instanceof AnyRefusal)) throw err;
    return null;
  }
}

export async function narrowsByACastClass(tx: Tx) {
  try {
    return await tx.execute('select 1' as never);
  } catch (err) {
    if (!(err instanceof (Error as unknown as typeof Refused))) throw err;
    return null;
  }
}

export async function narrowsByAReassignedHelper(tx: Tx) {
  try {
    return await tx.execute('select 1' as never);
  } catch (err) {
    if (!isMutableRefusal(err)) throw err;
    return null;
  }
}

export async function narrowsByAHelperOnAnObject(tx: Tx) {
  try {
    return await tx.execute('select 1' as never);
  } catch (err) {
    if (!refusalGuards.isRefusal(err)) throw err;
    return null;
  }
}

export async function narrowsByAReassignedReader(tx: Tx) {
  try {
    return await tx.execute('select 1' as never);
  } catch (err) {
    if (readCode(err) !== UNIQUE_VIOLATION) throw err;
    return null;
  }
}

export async function narrowsByAHelperFedTheErrorsOwnCode(tx: Tx) {
  try {
    return await tx.execute('select 1' as never);
  } catch (err) {
    if (!isCodeOf(err, (err as { code: '23505' }).code)) throw err;
    return null;
  }
}

export async function narrowsByAConstHelper(tx: Tx) {
  try {
    return await tx.execute('select 1' as never);
  } catch (err) {
    if (!isConstRefusal(err)) throw err;
    return null;
  }
}

export async function narrowsByACodeOnTheCause(tx: Tx) {
  try {
    return await tx.execute('select 1' as never);
  } catch (err) {
    if ((err as { cause?: { code?: string } }).cause?.code !== '23505') throw err;
    return null;
  }
}

export async function narrowsToAnotherLibraryClassOnTheCause(tx: Tx) {
  try {
    return await tx.execute('select 1' as never);
  } catch (err) {
    if (!((err as { cause?: unknown }).cause instanceof TypeError)) throw err;
    return null;
  }
}

export async function narrowsByTheCodeReader(tx: Tx) {
  try {
    return await tx.execute('select 1' as never);
  } catch (err) {
    if (pgErrorCode(err) !== UNIQUE_VIOLATION) throw err;
    return null;
  }
}

export async function narrowsByTheConstraintReader(tx: Tx) {
  try {
    return await tx.execute('select 1' as never);
  } catch (err) {
    if (pgConstraintName(err) !== 'pat_user_name_uniq') throw err;
    return null;
  }
}

export async function narrowsByACodeReadByIndex(tx: Tx) {
  try {
    return await tx.execute('select 1' as never);
  } catch (err) {
    if ((err as { code?: string })['code'] !== '23505') throw err;
    return null;
  }
}

export async function narrowsByAnotherErrorsName(tx: Tx) {
  try {
    return await tx.execute('select 1' as never);
  } catch (err) {
    if ((err as Error).name !== 'AbortError') throw err;
    return null;
  }
}

export async function narrowsToOneOfTwoCodes(tx: Tx) {
  try {
    return await tx.execute('select 1' as never);
  } catch (err) {
    if (isRefusal(err) || (err as { code?: string }).code === '23503') return null;
    throw err;
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
      ['narrowsByARecordGuard', 'tx'],
      ['narrowsByARecordPredicate', 'tx'],
      ['narrowsByAnErrnoPredicate', 'tx'],
      ['narrowsByAMessagePredicate', 'tx'],
      ['narrowsByAnOptionalPredicate', 'tx'],
      ['narrowsToEveryServerError', 'tx'],
      ['narrowsByAnIntersectionOfEvery', 'tx'],
      ['narrowsByTheNameEveryErrorHas', 'tx'],
      ['narrowsByTheConstructorEveryErrorHas', 'tx'],
      ['narrowsByAUniqueViolationPredicate', 'tx'],
      ['narrowsByAServerErrorName', 'tx'],
      ['returnsWhenNotNothing', 'tx'],
      ['narrowsByAHelperItCannotRead', 'tx'],
      ['continuesThroughASwitch', 'tx'],
      ['narrowsByTheNameReadByIndex', 'tx'],
      ['narrowsByTheNameOfErrorItself', 'tx'],
      ['narrowsByTheNameAsAString', 'tx'],
      ['narrowsByANamedErrorPredicate', 'tx'],
      ['narrowsByAStackPredicate', 'tx'],
      ['narrowsByAStackedErrorPredicate', 'tx'],
      ['narrowsByTheSeverityEveryServerErrorHas', 'tx'],
      ['narrowsByAClassItCannotResolve', 'tx'],
      ['narrowsByComparingTheErrorWithItself', 'tx'],
      ['narrowsToTheDrizzleWrapper', 'tx'],
      ['narrowsToTheDrizzleBase', 'tx'],
      ['narrowsToTheServerErrorOnTheCause', 'tx'],
      ['narrowsToARewrappedCause', 'tx'],
      ['narrowsByTheWrappersName', 'tx'],
      ['narrowsToTheConnectionClosedOnTheCause', 'tx'],
      ['returnsForTheConnectionEnded', 'tx'],
      ['narrowsToTheServerShuttingDown', 'tx'],
      ['returnsInsideTheRethrowBranch', 'tx'],
      ['returnsBeforeTheRethrow', 'tx'],
      ['narrowsAfterReassigningTheError', 'tx'],
      ['narrowsAShadowOfTheError', 'tx'],
      ['narrowsAfterWritingTheErrorsCode', 'tx'],
      ['narrowsAfterDestructuringIntoTheError', 'tx'],
      ['narrowsByAClassThatHoldsOfAll', 'tx'],
      ['narrowsByAClassInheritingThat', 'tx'],
      ['narrowsByACastClass', 'tx'],
      ['narrowsByAReassignedHelper', 'tx'],
      ['narrowsByAHelperOnAnObject', 'tx'],
      ['narrowsByAReassignedReader', 'tx'],
      ['narrowsByAHelperFedTheErrorsOwnCode', 'tx'],
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
    expect(kindOf('narrowsByACodedBody')).toBe('narrowed');
    expect(kindOf('narrowsByTheCodeReader')).toBe('narrowed');
    expect(kindOf('narrowsByTheConstraintReader')).toBe('narrowed');
    expect(kindOf('narrowsByACodeReadByIndex')).toBe('narrowed');
    expect(kindOf('narrowsByAnotherErrorsName')).toBe('narrowed');
    expect(kindOf('narrowsToOneOfTwoCodes')).toBe('narrowed');
    expect(kindOf('narrowsByAConstHelper')).toBe('narrowed');
    expect(kindOf('narrowsThenIndexesByTheError')).toBe('narrowed');
    expect(kindOf('narrowsByACodeOnTheCause')).toBe('narrowed');
    expect(kindOf('narrowsToAnotherLibraryClassOnTheCause')).toBe('narrowed');
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
