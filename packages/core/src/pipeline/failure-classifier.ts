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
 *   v3 — ISS-450 (ISS-442 C4) reshaped the union to the four kinds that the
 *     per-class retry policy actually branches on (Decision C):
 *       • code         — a defect the agent cannot retry past (was
 *                        `permanent`; e.g. invalid_request_error, content
 *                        filter, validation). retry.ts does NOT retry it; the
 *                        issue parks at `waiting`.
 *       • infra        — an environmental / provider / auth blip worth a
 *                        round-robin retry (absorbs the old `transient`,
 *                        `permission`, and the catch-all fallback).
 *       • transient-cc — a Claude-CLI startup death (the ISS-402 skill-
 *                        registration / "Unknown command" glitch): the session
 *                        dies before doing any real work (≤3 messages, no
 *                        tool_use). retry.ts does an IMMEDIATE different-device
 *                        failover, skipping the cooldown.
 *       • timeout      — heartbeat stale / no progress / ETIMEDOUT. Retryable.
 *     The fallback verdict is now `infra` (still retryable) with
 *     `meta.needsReview = true` so the operator UI can flag rows the patterns
 *     did not recognise. There is no more `unknown` kind.
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
];

// ISS-450 (ISS-402 signature) — a Claude-CLI session that dies during startup,
// most often the skill-registration / slash-command glitch. The error text
// alone is a strong, low-false-positive marker, so it doubles as a fallback for
// when the structured `signals` (message-count / first-tool-use) are absent.
const CC_STARTUP_PATTERNS: ReadonlyArray<RegExp> = [
  /\bunknown command\b/i,
  /\bunknown slash command\b/i,
  /\bcommand not found:\s*\/?forge/i,
  /skill[ _-]?registration (failed|error)/i,
];

/** Structured cc-startup-death signal derived from the linked agent_session.
 * A session that died before its first `tool_use` while still tiny (≤3
 * messages) never did real work — it is a Claude-CLI startup death, NOT a
 * code/infra failure, so it warrants an immediate different-device failover. */
export interface CcStartupSignals {
  diedBeforeFirstToolUse?: boolean;
  sessionMessageCount?: number;
}

/** Max messages a session may hold and still be treated as a startup death. */
const CC_STARTUP_MAX_MESSAGES = 3;

interface ClassifyInput {
  /** Free-form error excerpt (jobs.error or job_events result.result). */
  error?: string | null | undefined;
  /** Optional structured metadata from the runner stream (e.g. Anthropic
   * response: `{type:'error', error:{type:'invalid_request_error',...}}`).
   * May also carry `headers` from the provider response for Retry-After. */
  meta?: Record<string, unknown> | null | undefined;
  /** Optional structured startup-death signal (preferred over the error-text
   * pattern fallback when the caller can cheaply derive it). */
  signals?: CcStartupSignals | null | undefined;
}

/**
 * Classify a failure into code / infra / transient-cc / timeout plus a short
 * human-readable reason and an optional Retry-After timestamp. Always returns a
 * verdict — never throws.
 *
 * Match order: cc-startup signal → structured `meta.error.type` → CC-STARTUP
 * text → PERMISSION → TIMEOUT → PERMANENT → TRANSIENT → fallback. The fallback
 * is `infra` (retryable) and sets `meta.needsReview` so the operator UI can
 * flag rows the patterns did not recognise.
 *
 * Decision C mapping (ISS-450): permission→infra, permanent→code,
 * transient→infra, timeout→timeout, cc-startup→transient-cc.
 */
export function classifyFailure(input: ClassifyInput): ClassifyResult {
  const text = (input.error ?? '').trim();
  const meta = input.meta ?? null;
  const reasonExcerpt = text.length > 200 ? `${text.slice(0, 197)}…` : text;
  const retryAfter = extractRetryAfter(meta);

  // Structured cc-startup-death signal (preferred): a tiny session that never
  // reached its first tool_use is a Claude-CLI startup death → transient-cc.
  const signals = input.signals ?? null;
  if (
    signals?.diedBeforeFirstToolUse === true &&
    (signals.sessionMessageCount ?? 0) <= CC_STARTUP_MAX_MESSAGES
  ) {
    return {
      kind: 'transient-cc',
      reason: `cc-startup-death (≤${CC_STARTUP_MAX_MESSAGES} msgs, no tool use)`,
      meta,
      version: CLASSIFIER_VERSION,
      retryAfter,
    };
  }

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

  // cc-startup error signature (fallback when no structured signal): the
  // ISS-402 skill-registration / "Unknown command" death.
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
        reason: reasonExcerpt || 'code (pattern match)',
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
        reason: reasonExcerpt || 'infra (pattern match)',
        meta,
        version: CLASSIFIER_VERSION,
        retryAfter,
      };
    }
  }

  // Unrecognised — retryable `infra`, flagged for operator review.
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
