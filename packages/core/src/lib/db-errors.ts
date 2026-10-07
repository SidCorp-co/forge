/**
 * The one reader of a Postgres error. Drizzle throws `DrizzleQueryError` with the driver's error on
 * `cause`, and a caller may wrap that again, so every read walks the cause chain.
 */

const SQLSTATE = /^[0-9A-Z]{5}$/;
const MAX_CHAIN = 8;

export const UNIQUE_VIOLATION = '23505';

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
