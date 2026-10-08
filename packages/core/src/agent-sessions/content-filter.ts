const SYSTEM_NOISE_PREFIXES: RegExp[] = [
  /^\[RESULT_[A-Z_]+\]/,
  // Rehydration transcript markers from `buildRehydrationBlock` (chat-turn.ts).
  /^\[This is a cold start/,
  /^\[End of prior/,
];

/** True when `text` (already trimmed by the caller, or not) is empty or opens with a system/runner-internal marker. */
export function isSystemNoise(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return true;
  return SYSTEM_NOISE_PREFIXES.some((re) => re.test(trimmed));
}

export function stripSystemNoise(text: string): string {
  const trimmed = text.trim();
  return isSystemNoise(trimmed) ? '' : trimmed;
}
