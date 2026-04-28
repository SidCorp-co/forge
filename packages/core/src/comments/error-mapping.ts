// Helpers for translating Postgres errors raised inside drizzle-orm into the
// Hono response shape this module needs. drizzle wraps DB errors in
// `DrizzleQueryError` and may nest the original postgres error 1+ levels deep
// on `.cause`; both helpers walk the full chain.

const MAX_DEPTH = 5;

export function pgErrorCode(err: unknown): string | undefined {
  let cur: unknown = err;
  for (let depth = 0; cur && depth < MAX_DEPTH; depth++) {
    const code = (cur as { code?: unknown }).code;
    if (typeof code === 'string') return code;
    cur = (cur as { cause?: unknown }).cause;
  }
  return undefined;
}

// Postgres errors carry the violated constraint name; postgres-js exposes it as
// `constraint_name`, node-postgres as `constraint`. Used to disambiguate which
// FK fired on a 23503 — the comments INSERT touches three FKs (parent_id,
// issue_id, author_id) and only the parent_id case maps to PARENT_NOT_FOUND.
export function pgConstraintName(err: unknown): string | undefined {
  let cur: unknown = err;
  for (let depth = 0; cur && depth < MAX_DEPTH; depth++) {
    const c =
      (cur as { constraint_name?: unknown }).constraint_name ??
      (cur as { constraint?: unknown }).constraint;
    if (typeof c === 'string') return c;
    cur = (cur as { cause?: unknown }).cause;
  }
  return undefined;
}
