/**
 * Every way a Sentry read can be refused, as a value rather than a sentence: a caller telling
 * "no binding" from "the credential was rejected" by matching error text would reclassify both the
 * day one is reworded. The wording stays in `message`, the decision is made on `reason`.
 */
export const SENTRY_REFUSAL_REASONS = [
  'no_binding',
  'binding_disabled',
  'connection_disabled',
  'not_granted',
  'no_credential',
  'credential_rejected',
  'scope_missing',
  'sentry_http_error',
  'sentry_unreachable',
  'no_targets',
  'target_ambiguous',
  'target_unknown',
  'target_no_org',
  'confined_out',
  'bad_argument',
] as const;

export type SentryRefusalReason = (typeof SENTRY_REFUSAL_REASONS)[number];

export class SentryRefusal extends Error {
  readonly reason: SentryRefusalReason;
  /** Sentry's own status where one was reached; null where the call never got that far. */
  readonly httpStatus: number | null;
  /** The binding the refusal is about, where the refusal knows one. */
  readonly bindingId: string | null;

  constructor(
    reason: SentryRefusalReason,
    message: string,
    extra: { httpStatus?: number | null; bindingId?: string | null } = {},
  ) {
    super(message);
    this.name = 'SentryRefusal';
    this.reason = reason;
    this.httpStatus = extra.httpStatus ?? null;
    this.bindingId = extra.bindingId ?? null;
  }
}

export function isSentryRefusal(err: unknown): err is SentryRefusal {
  return err instanceof SentryRefusal;
}
