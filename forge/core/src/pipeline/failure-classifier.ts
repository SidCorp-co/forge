/**
 * Pipeline failure classifier (Phase H, ISS-306).
 *
 * Maps a job-failure error string + optional structured metadata to a
 * `kind` that the sweeper + scheduleRetry use to decide whether the
 * failure is worth retrying.
 *
 * `version` is bumped whenever the patterns below change semantically.
 * Persisted on `jobs.classifier_version` so that, when patterns evolve,
 * a re-classified historical row keeps its original verdict (the sweeper
 * reads jobs.failure_kind, never re-runs the classifier on archived
 * rows).
 *
 *   v1 — initial release.
 *     • permanent: content-filter / 4xx invalid_request_error / auth /
 *       validation / quota_exceeded
 *     • transient: timeout / network errors / 5xx / 429 / runner stale
 *     • unknown: anything else (default; gets one cautious retry then
 *       sweeper treats as permanent)
 */

export const CLASSIFIER_VERSION = 1;

export type FailureKind = 'transient' | 'permanent' | 'unknown';

export interface ClassifyResult {
  kind: FailureKind;
  reason: string;
  meta: Record<string, unknown> | null;
  version: number;
}

const PERMANENT_PATTERNS: ReadonlyArray<RegExp> = [
  /content[ _-]?filter(ing)?/i,
  /invalid_request_error/i,
  /\b(401|403)\b|\bunauthorized\b|\bforbidden\b/i,
  /\bvalidation[ _-]?error\b|\bschema[ _-]?error\b/i,
  /\bquota[ _-]?exceeded\b/i,
  /\bbilling[ _-]?(error|required)\b/i,
  /\bpermission[ _-]?denied\b/i,
];

const TRANSIENT_PATTERNS: ReadonlyArray<RegExp> = [
  /\btimeout\b|\bETIMEDOUT\b/i,
  /\bECONN(RESET|REFUSED|ABORTED)\b/i,
  /\bEPIPE\b|\bnetwork[ _-]?error\b/i,
  /\b50[0-9]\b|\bservice[ _-]?unavailable\b|\bbad[ _-]?gateway\b/i,
  /\b429\b|\brate[ _-]?limit/i,
  /runner (offline|stale|disconnected)/i,
  /no[ _-]?progress[ _-]?for[ _-]/i,
  /heartbeat[ _-]?(missing|stale)/i,
  /pg-?boss[ _-]?(error|timeout)/i,
];

interface ClassifyInput {
  /** Free-form error excerpt (jobs.error or job_events result.result). */
  error?: string | null | undefined;
  /** Optional structured metadata from the runner stream (e.g. Anthropic
   * response: `{type:'error', error:{type:'invalid_request_error',...}}`). */
  meta?: Record<string, unknown> | null | undefined;
}

/**
 * Classify a failure into transient / permanent / unknown plus a short
 * human-readable reason. Always returns a verdict — never throws — so
 * call sites can rely on `kind` for branching without a fallback.
 *
 * Match order: structured `meta.error.type` (highest signal) → text
 * patterns (permanent before transient because permanent indicators are
 * more specific) → unknown.
 */
export function classifyFailure(input: ClassifyInput): ClassifyResult {
  const text = (input.error ?? '').trim();
  const meta = input.meta ?? null;
  const reasonExcerpt = text.length > 200 ? `${text.slice(0, 197)}…` : text;

  // Structured signal: Anthropic / openai-style errors include a stable
  // `error.type` we can trust over text matching.
  const metaErrorType = readMetaErrorType(meta);
  if (metaErrorType) {
    if (
      metaErrorType === 'invalid_request_error' ||
      metaErrorType === 'authentication_error' ||
      metaErrorType === 'permission_error' ||
      metaErrorType === 'billing_error'
    ) {
      return {
        kind: 'permanent',
        reason: `${metaErrorType}: ${truncate(extractMetaMessage(meta) ?? reasonExcerpt, 150)}`,
        meta,
        version: CLASSIFIER_VERSION,
      };
    }
    if (
      metaErrorType === 'rate_limit_error' ||
      metaErrorType === 'overloaded_error' ||
      metaErrorType === 'api_error'
    ) {
      return {
        kind: 'transient',
        reason: `${metaErrorType}: ${truncate(extractMetaMessage(meta) ?? reasonExcerpt, 150)}`,
        meta,
        version: CLASSIFIER_VERSION,
      };
    }
  }

  for (const pat of PERMANENT_PATTERNS) {
    if (pat.test(text)) {
      return {
        kind: 'permanent',
        reason: reasonExcerpt || 'permanent (pattern match)',
        meta,
        version: CLASSIFIER_VERSION,
      };
    }
  }

  for (const pat of TRANSIENT_PATTERNS) {
    if (pat.test(text)) {
      return {
        kind: 'transient',
        reason: reasonExcerpt || 'transient (pattern match)',
        meta,
        version: CLASSIFIER_VERSION,
      };
    }
  }

  return {
    kind: 'unknown',
    reason: reasonExcerpt || 'unclassified',
    meta,
    version: CLASSIFIER_VERSION,
  };
}

function readMetaErrorType(meta: Record<string, unknown> | null): string | null {
  if (!meta) return null;
  const e = (meta as { error?: unknown }).error;
  if (e && typeof e === 'object') {
    const t = (e as { type?: unknown }).type;
    if (typeof t === 'string') return t;
  }
  // Some runners flatten the error onto the root object.
  const t = (meta as { type?: unknown }).type;
  if (typeof t === 'string' && t !== 'result') return t;
  return null;
}

function extractMetaMessage(meta: Record<string, unknown> | null): string | null {
  if (!meta) return null;
  const e = (meta as { error?: { message?: unknown } }).error;
  if (e?.message && typeof e.message === 'string') return e.message;
  const m = (meta as { message?: unknown }).message;
  return typeof m === 'string' ? m : null;
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
