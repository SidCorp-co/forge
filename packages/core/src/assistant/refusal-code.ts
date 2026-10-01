const CODE_RE = /\b([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)\b/;
const LEADING_CODE_RE = /^([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*):/;

function codeIn(value: unknown): string | null {
  if (typeof value === 'string') {
    return value.match(LEADING_CODE_RE)?.[1] ?? value.match(CODE_RE)?.[1] ?? null;
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (typeof record.code === 'string') return record.code;
    for (const key of ['error', 'stderr', 'stdout', 'message']) {
      const found = codeIn(record[key]);
      if (found) return found;
    }
  }
  return null;
}

/** The code a refused tool result names: its `error.code`, a leading `CODE:`, or the first UPPER_SNAKE token it carries. */
export function refusalCodeOf(text: string): string | null {
  try {
    return codeIn(JSON.parse(text)) ?? text.match(CODE_RE)?.[1] ?? null;
  } catch {
    return codeIn(text);
  }
}
