// Which no-retry outcomes park an issue on a condition that clears by itself,
// and which park it on a decision only a human can make.
//
// `waiting` is one status carrying two very different meanings. A step that
// CONCLUDED it cannot proceed (reopen cap, non-retryable failure, an
// unanswerable question) must not be re-run unchanged — that is what
// bounce-replay-guard.ts protects. A step cut off by provider quota reached no
// conclusion at all; once capacity returns, re-running it is the only useful
// move, and demanding a human answer first is asking a question nobody asked.
//
// ISS-163 (sidpeak) is the incident: an account spend limit parked a `fix`
// step, every runner recovered inside the hour, and the issue still could not
// move — the replay guard read the capacity park as an unanswered question and
// routed every attempt back to `waiting`.

// cm:edge contract -> packages/core/src/jobs/retry.ts — these are `RetryOutcome.reason` values, not the derived `WaitingCause` vocabulary; a new no-retry reason there must be classified here
// cm:why `monthly_budget_exhausted` is deliberately NOT capacity: its condition is a project spend budget this module cannot re-check, so admitting it would let a re-dispatch fire straight back into the dispatcher's budget refusal (dispatcher.ts) and re-park on arrival. Only reasons whose clearance is verifiable belong here.
export const CAPACITY_PARK_REASONS: ReadonlySet<string> = new Set(['all_devices_exhausted']);

export function isCapacityParkReason(reason: string | null | undefined): boolean {
  return typeof reason === 'string' && CAPACITY_PARK_REASONS.has(reason);
}
