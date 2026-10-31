import { SENTRY_REFUSAL_CODES, type SentryRefusalCode } from '@forge/contracts/integrations';
import { RefusalError } from '../../lib/refusal.js';

/**
 * A Sentry read refused under one of `SENTRY_REFUSAL_CODES`, as a value both doors answer in the
 * envelope: a caller telling "no binding" from "the credential was rejected" by matching error text
 * would reclassify both the day one is reworded. The wording stays in `message`, the decision is
 * made on the code.
 */
export function refuseSentry(code: SentryRefusalCode, message: string): RefusalError {
  return new RefusalError([{ code, path: '', detail: message }], code);
}

const SENTRY_CODES: readonly string[] = SENTRY_REFUSAL_CODES;

/** The Sentry code a thrown refusal answers under, or null for anything that is not one. */
export function sentryRefusalCode(err: unknown): SentryRefusalCode | null {
  if (!(err instanceof RefusalError)) return null;
  const code = err.refusals[0]?.code;
  return code !== undefined && SENTRY_CODES.includes(code) ? (code as SentryRefusalCode) : null;
}

/** The sentence a thrown error carries: a refusal's own detail, never its `CODE: detail` rendering. */
export function sentryDetailOf(err: unknown): string {
  if (err instanceof RefusalError) return err.refusals[0]?.detail ?? err.message;
  return err instanceof Error ? err.message : 'unknown error';
}

export function isSentryRefusal(err: unknown): err is RefusalError {
  return sentryRefusalCode(err) !== null;
}
