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
 *   v3 — ISS-450 (ISS-442 C4 / I4) taxonomy rebuild. The `unknown` class is
 *     ELIMINATED — every failure maps to exactly one of four kinds, each with
 *     its own retry policy (see jobs/retry.ts):
 *     • code         — the work itself is wrong (old `permanent`: content
 *       filter, invalid_request, validation, billing/quota, unsupported
 *       type). Retrying burns spend without changing the outcome → no retry.
 *     • infra        — the environment failed, not the work (old `permission`
 *       + old `transient`: auth/403, network, 5xx, rate limits, runner
 *       offline, preflight failures). Bounded round-robin retry.
 *     • transient-cc — Claude-CLI startup death (ISS-402 class: the session
 *       died with ≤3 messages and no tool use, e.g. the skill-registration
 *       "Unknown command" glitch). Same-device retries burn the whole budget
 *       against a wedged CLI install → immediate different-device failover.
 *     • timeout      — no progress past threshold. Bounded retry.
 *     The pattern→bucket fallthrough (`unknown`) now lands on `infra` with
 *     `meta.needsReview=true` so unclassified rows surface in the operator UI
 *     instead of hiding behind a fifth class.
 */

import { parseRetryAfter, readRetryAfterHeader } from './retry-after-parser.js';

export const CLASSIFIER_VERSION = 3;

export type FailureKind = 'code' | 'infra' | 'transient-cc' | 'timeout';

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
  // ISS-451 (C5) — runner pre-claim preflight failures (missing repo, bad git
  // tree, unreachable push remote, missing hooks path) are environment
  // problems by construction.
  /\bpreflight[ _-]?failed\b/i,
];

// ISS-450 — the ISS-402 cc-startup-death signature, used only as a TEXT
// fallback when the caller could not derive structured `signals` (the
// preferred source). A Claude-CLI session that dies during startup retries
// uselessly on the same device; `transient-cc` routes it to an immediate
// different-device failover instead.
const CC_STARTUP_PATTERNS: ReadonlyArray<RegExp> = [
  /\bunknown command\b/i,
  /skill[ _-]?registration/i,
];

interface ClassifyInput {
  /** Free-form error excerpt (jobs.error or job_events result.result). */
  error?: string | null | undefined;
  /** Optional structured metadata from the runner stream (e.g. Anthropic
   * response: `{type:'error', error:{type:'invalid_request_error',...}}`).
   * May also carry `headers` from the provider response for Retry-After. */
  meta?: Record<string, unknown> | null | undefined;
  /** ISS-450 — structured cc-startup-death signal derived from the job's
   * event stream (preferred over the CC_STARTUP_PATTERNS text fallback).
   * `diedBeforeFirstToolUse` = the job emitted zero tool_call events. */
  signals?:
    | {
        diedBeforeFirstToolUse?: boolean;
        sessionMessageCount?: number;
      }
    | null
    | undefined;
}

/**
 * Classify a failure into code / infra / transient-cc / timeout plus a short
 * human-readable reason and an optional Retry-After timestamp. Always returns
 * a verdict — never throws, never `unknown`.
 *
 * Match order: structured `meta.error.type` → cc-startup signal →
 * PERMISSION (infra) → TIMEOUT → PERMANENT (code) → TRANSIENT (infra) →
 * CC_STARTUP text fallback → infra + needsReview. Permission/timeout precede
 * the broader buckets because their patterns are more specific.
 */
export function classifyFailure(input: ClassifyInput): ClassifyResult {
  const text = (input.error ?? '').trim();
  const meta = input.meta ?? null;
  const reasonExcerpt = text.length > 200 ? `${text.slice(0, 197)}…` : text;
  const retryAfter = extractRetryAfter(meta);

  const metaErrorType = readMetaErrorType(meta);
  if (metaErrorType) {
    if (metaErrorType === 'authentication_error' || metaErrorType === 'permission_error') {
      return {
        kind: 'infra',
        reason: `${metaErrorType}: ${truncate(extractMetaMessage(meta) ?? reasonExcerpt, 150)}`,
        meta,
        version: CLASSIFIER_VERSION,
        retryAfter,
      };
    }
    if (metaErrorType === 'invalid_request_error' || metaErrorType === 'billing_error') {
      return {
        kind: 'code',
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
        kind: 'infra',
        reason: `${metaErrorType}: ${truncate(extractMetaMessage(meta) ?? reasonExcerpt, 150)}`,
        meta,
        version: CLASSIFIER_VERSION,
        retryAfter,
      };
    }
  }

  // ISS-450 — structured cc-startup-death signal (preferred source). The
  // caller derives it from the job's event stream: the CLI spawned but died
  // with ≤3 assistant messages and no tool use (ISS-402 skill-registration
  // glitch class). Checked before the text passes so a generic error string
  // from a startup death still routes to the immediate-failover policy.
  if (
    input.signals?.diedBeforeFirstToolUse === true &&
    (input.signals.sessionMessageCount ?? 0) <= 3
  ) {
    return {
      kind: 'transient-cc',
      reason: 'cc-startup-death (≤3 msgs, no tool use)',
      meta,
      version: CLASSIFIER_VERSION,
      retryAfter,
    };
  }

  for (const pat of PERMISSION_PATTERNS) {
    if (pat.test(text)) {
      return {
        kind: 'infra',
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
        kind: 'code',
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
        kind: 'infra',
        reason: reasonExcerpt || 'transient (pattern match)',
        meta,
        version: CLASSIFIER_VERSION,
        retryAfter,
      };
    }
  }

  for (const pat of CC_STARTUP_PATTERNS) {
    if (pat.test(text)) {
      return {
        kind: 'transient-cc',
        reason: reasonExcerpt || 'cc-startup-death (pattern match)',
        meta,
        version: CLASSIFIER_VERSION,
        retryAfter,
      };
    }
  }

  // No bucket matched. There is no `unknown` class anymore (I4): default to
  // `infra` (bounded retry — the conservative choice) and flag the row for
  // the operator UI so the pattern gap is visible instead of hidden.
  return {
    kind: 'infra',
    reason: reasonExcerpt || 'unclassified',
    meta: { ...(meta ?? {}), needsReview: true },
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
