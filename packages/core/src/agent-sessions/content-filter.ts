/**
 * Shared system/error-string denylist for the chat-turn title path
 * (`chat-turn.ts` / `auto-title.ts`) AND the conversation-list preview
 * (`chat-preview.ts`). Centralized so a new runner-internal marker is a
 * one-line add instead of a duplicated regex per call site.
 */
const SYSTEM_NOISE_PREFIXES: RegExp[] = [
  // Built in packages/runner/crates/forge-runner-core/src/runner/claude_code.rs
  // and scanned in session-failure.ts / pipeline/failure-classifier.ts.
  /^\[RESULT_[A-Z_]+\]/,
  // `formatPageContextLine` in page-context.ts.
  /^\[Context:/,
  // Rehydration transcript markers from `buildRehydrationBlock` (chat-turn.ts).
  /^\[Your previous session/,
  /^\[End of prior/,
];

const CONTEXT_LINE_RE = /^\[Context:[^\]]*\]\s*/;

/** True when `text` (already trimmed by the caller, or not) is empty or opens with a system/runner-internal marker. */
export function isSystemNoise(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return true;
  return SYSTEM_NOISE_PREFIXES.some((re) => re.test(trimmed));
}

/**
 * Strip a leading `[Context: …]` decoration, then drop the remainder entirely
 * (return '') if it is still system noise. Callers (title derivation, list
 * preview) treat '' the same as "no usable text".
 */
export function stripSystemNoise(text: string): string {
  const withoutContext = text.replace(CONTEXT_LINE_RE, '').trim();
  return isSystemNoise(withoutContext) ? '' : withoutContext;
}
