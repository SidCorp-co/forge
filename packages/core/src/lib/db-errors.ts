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
