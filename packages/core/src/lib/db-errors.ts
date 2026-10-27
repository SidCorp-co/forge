/**
 * The one reader of a Postgres error. Drizzle throws `DrizzleQueryError` with the driver's error on
 * `cause`, and a caller may wrap that again, so every read walks the cause chain.
 */

import { constants } from 'node:os';
import { DrizzleQueryError, TransactionRollbackError } from 'drizzle-orm/errors';
import postgres from 'postgres';

const SQLSTATE = /^[0-9A-Z]{5}$/;
const MAX_CHAIN = 8;

export const UNIQUE_VIOLATION = '23505';

/**
 * Every class a call on a transaction throws: drizzle wraps whatever the driver rejected a statement
 * with in `DrizzleQueryError`, whose `cause` is the server's `PostgresError` or the plain `Error` the
 * driver raises for a session it lost, and `tx.rollback()` throws `TransactionRollbackError`, which
 * a catch that goes on turns into a commit. The catch scan (`src/db/in-transaction-catches.fixture.ts`)
 * reads this list as the errors a guard has to tell apart.
 */
export const STATEMENT_ERRORS = [
  DrizzleQueryError,
  postgres.PostgresError,
  TransactionRollbackError,
  Error,
] as const;

/**
 * Codes an error carries once its session is gone: the driver's for a lost connection, every errno
 * name (the driver rejects a statement with its socket's own error, whichever errno the system gave
 * it), and the SQLSTATEs the server ends a session with.
 */
export const SESSION_ENDED_CODES: ReadonlySet<string> = new Set([
  'CONNECTION_CLOSED',
  'CONNECTION_ENDED',
  'CONNECTION_DESTROYED',
  'CONNECT_TIMEOUT',
  ...Object.keys(constants.errno),
  '08000',
  '08003',
  '08006',
  '08001',
  '08004',
  '08007',
  '08P01',
  '25P03',
  '25P04',
  '57P01',
  '57P02',
  '57P03',
  '57P04',
  '57P05',
]);

function* causeChain(err: unknown): Generator<Record<string, unknown>> {
  const seen = new Set<unknown>();
  for (let cur = err, i = 0; cur && typeof cur === 'object' && i < MAX_CHAIN; i++) {
    if (seen.has(cur)) return;
    seen.add(cur);
    yield cur as Record<string, unknown>;
    cur = (cur as { cause?: unknown }).cause;
  }
}

/** The SQLSTATE on the chain; a code of another shape (`ENOENT`, `CONNECTION_CLOSED`) is not one. */
export function pgErrorCode(err: unknown): string | undefined {
  for (const link of causeChain(err)) {
    if (typeof link.code === 'string' && SQLSTATE.test(link.code)) return link.code;
  }
  return undefined;
}

/** The deepest constraint name on the chain, which is the driver's own. */
export function pgConstraintName(err: unknown): string | undefined {
  let found: string | undefined;
  for (const link of causeChain(err)) {
    const name = link.constraint_name ?? link.constraint;
    if (typeof name === 'string') found = name;
  }
  return found;
}

export function isUniqueViolation(err: unknown): boolean {
  return pgErrorCode(err) === UNIQUE_VIOLATION;
}

/** The driver's own error on the chain: the deepest link carrying an SQLSTATE and a message. */
export function pgDriverError(err: unknown): { code: string; message: string } | undefined {
  let found: { code: string; message: string } | undefined;
  for (const link of causeChain(err)) {
    if (
      typeof link.code === 'string' &&
      SQLSTATE.test(link.code) &&
      typeof link.message === 'string'
    )
      found = { code: link.code, message: link.message };
  }
  return found;
}

/** A schema object the driver's error names. */
export interface PgObjectName {
  kind: 'constraint' | 'table' | 'column' | 'schema' | 'type';
  name: string;
}

/** Each field naming a schema object, as postgres-js and node-postgres spell it. */
const OBJECT_NAME_FIELDS: ReadonlyArray<readonly [string, PgObjectName['kind']]> = [
  ['constraint_name', 'constraint'],
  ['constraint', 'constraint'],
  ['table_name', 'table'],
  ['table', 'table'],
  ['column_name', 'column'],
  ['column', 'column'],
  ['schema_name', 'schema'],
  ['schema', 'schema'],
  ['data_type_name', 'type'],
  ['dataType', 'type'],
];

/** Longest name first; a name is the schema's own text, never a value of the statement. */
export function pgObjectNames(err: unknown): PgObjectName[] {
  const found = new Map<string, PgObjectName>();
  for (const link of causeChain(err)) {
    if (typeof link.code !== 'string' || !SQLSTATE.test(link.code)) continue;
    for (const [field, kind] of OBJECT_NAME_FIELDS) {
      const name = link[field];
      if (typeof name === 'string' && name !== '') found.set(`${kind}:${name}`, { kind, name });
    }
  }
  return [...found.values()].sort((a, b) => b.name.length - a.name.length);
}

/** Every value bound to a failed statement on the chain, as text, empty ones left out. */
export function pgBoundValues(err: unknown): string[] {
  const values: string[] = [];
  for (const link of causeChain(err)) {
    const bound = Array.isArray(link.params) ? link.params : link.parameters;
    if (!Array.isArray(bound)) continue;
    for (const v of bound) if (v !== null && v !== undefined && `${v}` !== '') values.push(`${v}`);
  }
  return values;
}

/** What an SQLSTATE's class means, in words a person reads; the class is its first two characters. */
const SQLSTATE_CLASS: Record<string, string> = {
  '08': 'the connection to the database failed',
  '22': 'a value it was given was invalid',
  '23': 'a rule on the table refused the row',
  '25': 'the transaction was in a state that refused the write',
  '40': 'the database rolled the transaction back',
  '42': 'the statement was not allowed or not valid',
  '53': 'the database ran short of a resource',
  '57': 'the database was stopped or cancelled the statement',
  P0: 'a database function or trigger raised an error',
};

export function pgErrorClassDescription(code: string): string {
  return SQLSTATE_CLASS[code.slice(0, 2)] ?? 'the database refused the statement';
}
