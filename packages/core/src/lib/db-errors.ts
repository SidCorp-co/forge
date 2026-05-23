/**
 * Detect Postgres SQLSTATE 23505 (unique_violation), tolerating Drizzle's
 * outer wrapper. With `drizzle-orm/postgres-js`, the postgres-js driver
 * sets `code: '23505'` on the raw error, but Drizzle re-throws it inside a
 * `{ query, params, cause }` wrapper — so the SQLSTATE lives on
 * `err.cause.code`, not the top level. Plain inserts (and the node-postgres
 * driver in other code paths) surface it on the top level. Check both so a
 * single helper works regardless of which path the caller took.
 */
export function isUniqueViolation(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { code?: unknown; cause?: { code?: unknown } };
  return e.code === '23505' || e.cause?.code === '23505';
}

/**
 * Return the constraint name for a Postgres unique-violation error, or
 * undefined if the error isn't one or the driver didn't surface it.
 * postgres-js uses snake_case `constraint_name`; node-postgres uses
 * `constraint`. Check both. Always walks `err.cause` for Drizzle-wrapped
 * errors first (where the raw error lives).
 */
export function uniqueViolationConstraint(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const e = err as {
    constraint?: unknown;
    constraint_name?: unknown;
    cause?: { constraint?: unknown; constraint_name?: unknown };
  };
  const fromCause =
    typeof e.cause?.constraint_name === 'string'
      ? e.cause.constraint_name
      : typeof e.cause?.constraint === 'string'
        ? e.cause.constraint
        : undefined;
  if (fromCause) return fromCause;
  if (typeof e.constraint_name === 'string') return e.constraint_name;
  if (typeof e.constraint === 'string') return e.constraint;
  return undefined;
}
