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
