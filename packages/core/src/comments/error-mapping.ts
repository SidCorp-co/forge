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
