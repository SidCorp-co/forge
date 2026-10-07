/**
 * The I1 trigger's refusal (0403): a job or session written active under a terminal run raises
 * SQLSTATE 23514 with a message led by `ACTIVE_CHILD_UNDER_TERMINAL_RUN`. Its message, or null.
 */
export function activeChildUnderTerminalRun(err: unknown): string | null {
  for (let e: unknown = err, depth = 0; e && typeof e === 'object' && depth < 3; depth++) {
    const { code, message, cause } = e as { code?: unknown; message?: unknown; cause?: unknown };
    if (
      code === '23514' &&
      typeof message === 'string' &&
      message.startsWith('ACTIVE_CHILD_UNDER_TERMINAL_RUN')
    ) {
      return message;
    }
    e = cause;
  }
  return null;
}

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

const MAX_CAUSE_DEPTH = 5;

export function pgErrorCode(err: unknown): string | undefined {
  let cur: unknown = err;
  for (let depth = 0; cur && depth < MAX_CAUSE_DEPTH; depth++) {
    const code = (cur as { code?: unknown }).code;
    if (typeof code === 'string') return code;
    cur = (cur as { cause?: unknown }).cause;
  }
  return undefined;
}

export function pgConstraintName(err: unknown): string | undefined {
  let cur: unknown = err;
  for (let depth = 0; cur && depth < MAX_CAUSE_DEPTH; depth++) {
    const c =
      (cur as { constraint_name?: unknown }).constraint_name ??
      (cur as { constraint?: unknown }).constraint;
    if (typeof c === 'string') return c;
    cur = (cur as { cause?: unknown }).cause;
  }
  return undefined;
}
