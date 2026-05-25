/**
 * Pipeline failure classifier.
 *
 * Maps a job-failure error string + optional structured metadata to a
 * `kind` that the sweeper + scheduleAutoRetryWithVerify use to decide
 * whether the failure is worth retrying.
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
 *   v2 — ISS-197 split permission / timeout out of permanent / transient.
 *     • permission: 401/403, authentication_error, permission_error,
 *       permission_denied. Non-retryable like permanent.
 *     • timeout: timeout / ETIMEDOUT / heartbeat stale / no progress.
 *       Retryable like transient.
 *     • retryAfter: Date | null extracted from
 *       `meta.headers['retry-after']` (RFC 7231) for the retry engine to
 *       honour rate limits before scheduling.
 */

import { parseRetryAfter, readRetryAfterHeader } from './retry-after-parser.js';

export const CLASSIFIER_VERSION = 2;

export type FailureKind =
  | 'transient'
  | 'permission'
  | 'permanent'
  | 'timeout'
  | 'unknown';

export interface ClassifyResult {
  kind: FailureKind;
  reason: string;
  meta: Record<string, unknown> | null;
  version: number;
  /** Provider Retry-After hint as an absolute timestamp, or null. */
  retryAfter: Date | null;
}

const PERMISSION_PATTERNS: ReadonlyArray<RegExp> = [
  /\b(401|403)\b/,
  /\bunauthorized\b/i,
  /\bforbidden\b/i,
  /\bpermission[ _-]?denied\b/i,
];

const TIMEOUT_PATTERNS: ReadonlyArray<RegExp> = [
  /\btimeout\b/i,
  /\bETIMEDOUT\b/i,
  /no[ _-]?progress[ _-]?for[ _-]/i,
  /heartbeat[ _-]?(missing|stale)/i,
];

// Subpatterns moved to PERMISSION_PATTERNS / TIMEOUT_PATTERNS above are
// intentionally absent here so each text matches exactly one bucket.
const PERMANENT_PATTERNS: ReadonlyArray<RegExp> = [
  /content[ _-]?filter(ing)?/i,
  /invalid_request_error/i,
  /\bvalidation[ _-]?error\b|\bschema[ _-]?error\b/i,
  /\bquota[ _-]?exceeded\b/i,
  /\bbilling[ _-]?(error|required)\b/i,
  /\bmissing_prompt_string\b/i,
  /\brunner_unsupported_type\b/i,
];

const TRANSIENT_PATTERNS: ReadonlyArray<RegExp> = [
  /\bECONN(RESET|REFUSED|ABORTED)\b/i,
  /\bEPIPE\b|\bnetwork[ _-]?error\b/i,
  /\b50[0-9]\b|\bservice[ _-]?unavailable\b|\bbad[ _-]?gateway\b/i,
  /\b429\b|\brate[ _-]?limit/i,
  /runner (offline|stale|disconnected)/i,
  /pg-?boss[ _-]?(error|timeout)/i,
];

interface ClassifyInput {
  /** Free-form error excerpt (jobs.error or job_events result.result). */
  error?: string | null | undefined;
  /** Optional structured metadata from the runner stream (e.g. Anthropic
   * response: `{type:'error', error:{type:'invalid_request_error',...}}`).
   * May also carry `headers` from the provider response for Retry-After. */
  meta?: Record<string, unknown> | null | undefined;
}

/**
 * Classify a failure into transient / permission / permanent / timeout /
 * unknown plus a short human-readable reason and an optional Retry-After
 * timestamp. Always returns a verdict — never throws.
 *
 * Match order: structured `meta.error.type` → PERMISSION → TIMEOUT →
 * PERMANENT → TRANSIENT → unknown. Permission/timeout precede the broader
 * permanent/transient buckets because their patterns are more specific.
 */
export function classifyFailure(input: ClassifyInput): ClassifyResult {
  const text = (input.error ?? '').trim();
  const meta = input.meta ?? null;
  const reasonExcerpt = text.length > 200 ? `${text.slice(0, 197)}…` : text;
  const retryAfter = extractRetryAfter(meta);

  // ISS-210 / W2.3.3 — per-run budget kill is a runner-side enforcement
  // that emits an `agent:complete` with `error='per_run_budget_exceeded:…'`.
  // When the renderer's `completeJob` (exitCode=1) wins the race against
  // the dedicated `failJob` POST, the classifier sees this error first;
  // returning `permanent` here ensures `recoveryByFailureKind.permanent=0`
  // suppresses retries either way.
  if (text.startsWith('per_run_budget_exceeded')) {
    return {
      kind: 'permanent',
      reason: 'per_run_budget_exceeded',
      meta,
      version: CLASSIFIER_VERSION,
      retryAfter,
    };
  }

  const metaErrorType = readMetaErrorType(meta);
  if (metaErrorType) {
    if (
      metaErrorType === 'authentication_error' ||
      metaErrorType === 'permission_error'
    ) {
      return {
        kind: 'permission',
        reason: `${metaErrorType}: ${truncate(extractMetaMessage(meta) ?? reasonExcerpt, 150)}`,
        meta,
        version: CLASSIFIER_VERSION,
        retryAfter,
      };
    }
    if (
      metaErrorType === 'invalid_request_error' ||
      metaErrorType === 'billing_error'
    ) {
      return {
        kind: 'permanent',
        reason: `${metaErrorType}: ${truncate(extractMetaMessage(meta) ?? reasonExcerpt, 150)}`,
        meta,
        version: CLASSIFIER_VERSION,
        retryAfter,
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
        retryAfter,
      };
    }
  }

  for (const pat of PERMISSION_PATTERNS) {
    if (pat.test(text)) {
      return {
        kind: 'permission',
        reason: reasonExcerpt || 'permission (pattern match)',
        meta,
        version: CLASSIFIER_VERSION,
        retryAfter,
      };
    }
  }

  for (const pat of TIMEOUT_PATTERNS) {
    if (pat.test(text)) {
      return {
        kind: 'timeout',
        reason: reasonExcerpt || 'timeout (pattern match)',
        meta,
        version: CLASSIFIER_VERSION,
        retryAfter,
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
        retryAfter,
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
        retryAfter,
      };
    }
  }

  return {
    kind: 'unknown',
    reason: reasonExcerpt || 'unclassified',
    meta,
    version: CLASSIFIER_VERSION,
    retryAfter,
  };
}

function readMetaErrorType(meta: Record<string, unknown> | null): string | null {
  if (!meta) return null;
  const e = (meta as { error?: unknown }).error;
  if (e && typeof e === 'object') {
    const t = (e as { type?: unknown }).type;
    if (typeof t === 'string') return t;
  }
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

function extractRetryAfter(meta: Record<string, unknown> | null): Date | null {
  if (!meta) return null;
  // Common shapes: `{ headers: {...} }`, `{ response: { headers: {...} } }`,
  // or `{ error: { headers: {...} } }`. Probe each.
  const candidates: Array<Record<string, unknown> | undefined> = [];
  const direct = (meta as { headers?: unknown }).headers;
  if (direct && typeof direct === 'object') {
    candidates.push(direct as Record<string, unknown>);
  }
  const resp = (meta as { response?: { headers?: unknown } }).response;
  if (resp?.headers && typeof resp.headers === 'object') {
    candidates.push(resp.headers as Record<string, unknown>);
  }
  const err = (meta as { error?: { headers?: unknown } }).error;
  if (err?.headers && typeof err.headers === 'object') {
    candidates.push(err.headers as Record<string, unknown>);
  }
  for (const headers of candidates) {
    const raw = readRetryAfterHeader(headers);
    if (raw) {
      const parsed = parseRetryAfter(raw);
      if (parsed) return parsed;
    }
  }
  return null;
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
