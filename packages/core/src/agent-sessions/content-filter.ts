const SYSTEM_NOISE_PREFIXES: RegExp[] = [
  /^\[RESULT_[A-Z_]+\]/,
  /^\[Context:/,
  // Rehydration transcript markers from `buildRehydrationBlock` (chat-turn.ts).
  /^\[This is a cold start/,
  /^\[End of prior/,
];

const CONTEXT_LINE_RE = /^\[Context:[^\]]*\]\s*/;

/** True when `text` (already trimmed by the caller, or not) is empty or opens with a system/runner-internal marker. */
export function isSystemNoise(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return true;
  return SYSTEM_NOISE_PREFIXES.some((re) => re.test(trimmed));
}

export function stripSystemNoise(text: string): string {
  const withoutContext = text.replace(CONTEXT_LINE_RE, '').trim();
  return isSystemNoise(withoutContext) ? '' : withoutContext;
}
