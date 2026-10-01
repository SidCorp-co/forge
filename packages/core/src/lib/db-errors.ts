export function isUniqueViolation(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { code?: unknown; cause?: { code?: unknown } };
  return e.code === '23505' || e.cause?.code === '23505';
}

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

const REDACTED_PARAMS = 'params: [Redacted]';

/** Drizzle's failed-query errors in `err`'s cause chain, told by the message drizzle builds. */
function failedQueries(err: unknown): { message: string; query: string }[] {
  const found: { message: string; query: string }[] = [];
  for (let cur: unknown = err, depth = 0; cur instanceof Error && depth < 8; depth++) {
    const q = cur as Error & { query?: unknown; params?: unknown };
    if (typeof q.query === 'string' && Array.isArray(q.params)) {
      if (q.message === `Failed query: ${q.query}\nparams: ${q.params}`) {
        found.push({ message: q.message, query: q.query });
      }
    }
    cur = q.cause;
  }
  return found;
}

/**
 * `value` (a string, or what a serializer made of `err`) with every bound param of a failed query
 * in `err`'s chain redacted. A param is whatever a statement bound — a password hash, a token —
 * so none is shown, in a response or a log.
 */
export function withoutQueryParams<T>(value: T, err: unknown): T {
  const queries = failedQueries(err);
  if (queries.length === 0) return value;
  const scrub = (v: unknown, key?: string): unknown => {
    if (typeof v === 'string') {
      return queries.reduce(
        (s, q) => s.replaceAll(q.message, `Failed query: ${q.query}\n${REDACTED_PARAMS}`),
        v,
      );
    }
    if (key === 'params' && Array.isArray(v)) return '[Redacted]';
    if (Array.isArray(v)) return v.map((x) => scrub(x));
    if (v && typeof v === 'object' && !(v instanceof Error)) {
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, scrub(x, k)]));
    }
    return v;
  };
  return scrub(value) as T;
}
