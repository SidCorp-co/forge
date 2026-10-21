import { CoolifyApiError, coolifyAbilityForRoute, describeCoolifyAnswer } from './client.js';

interface CoolifyFailureVerdict {
  health: 'needs_reauth' | 'needs_scope' | 'error';
  /** Operator-facing sentence for a 403; `null` leaves the raw error message. */
  message: string | null;
  route: string | null;
  missingAbility: string | null;
}

/** Which health state a failed call earns: 401 and 403 are told apart here or nowhere (ISS-924). */
export function classifyCoolifyFailure(err: unknown): CoolifyFailureVerdict {
  const status = err instanceof CoolifyApiError ? err.status : null;
  const route = err instanceof CoolifyApiError ? err.route : null;
  if (err instanceof CoolifyApiError && (status === 401 || status === 403)) {
    const health = status === 401 ? 'needs_reauth' : 'needs_scope';
    const missingAbility = status === 403 ? coolifyAbilityForRoute(route) : null;
    return { health, message: describeCoolifyAnswer(err), route, missingAbility };
  }
  return { health: 'error', message: null, route, missingAbility: null };
}

/** A failed check in words, with what to do where the host's answer says the address may be wrong. */
export function checkFailureWords(err: unknown): string {
  if (!(err instanceof Error)) return 'unknown error';
  if (!(err instanceof CoolifyApiError)) return err.message;
  if (err.addressSuspect)
    return `${err.message} Check the address saved on this connection, then test again.`;
  return err.status >= 500 ? `${err.message} Test again once it answers.` : err.message;
}

/** The message a failure is recorded and reported under. */
export function describeCoolifyFailure(err: unknown): string {
  const verdict = classifyCoolifyFailure(err);
  if (verdict.message) return verdict.message;
  return err instanceof Error ? err.message : 'unknown error';
}
