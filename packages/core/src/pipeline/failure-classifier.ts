import { isSpendLimitError, isUsageLimitError } from '@forge/contracts/runners';
import type { FailureCause } from './failure-causes.js';
import {
  BOX_SATURATION_PATTERNS,
  CC_STARTUP_PATTERNS,
  causeForMetaErrorType,
  causeForText,
  DUPLEX_SESSION_PATTERNS,
  PERMANENT_PATTERNS,
  PERMISSION_PATTERNS,
  PREFLIGHT_PATTERNS,
  REPO_CONTENTION_PATTERNS,
  STOPPED_ON_QUESTION_PATTERNS,
  TERMINAL_INFRA_PATTERNS,
  TIMEOUT_PATTERNS,
  TRANSIENT_PATTERNS,
} from './failure-patterns.js';
import { parseRetryAfter, readRetryAfterHeader } from './retry-after-parser.js';

export const CLASSIFIER_VERSION = 12;

export type FailureKind = 'code' | 'infra' | 'transient-cc' | 'timeout';

export type FailureAction = 'terminal' | 'quarantine' | 'failover' | 'retry';

interface ClassifyResult {
  kind: FailureKind;
  /** Policy verdict callers must obey instead of re-deriving from `kind`. */
  action: FailureAction;
  /** Diagnosis: what happened, in the ISS-877 taxonomy. Independent of both
   *  `kind` and `action` — a provider spend cap and a runner going offline are
   *  the same policy and different causes. */
  cause: FailureCause;
  reason: string;
  meta: Record<string, unknown> | null;
  version: number;
  /** Provider Retry-After hint as an absolute timestamp, or null. */
  retryAfter: Date | null;
}

/**
 * Fallback for job rows persisted before ISS-823 (`failure_action IS NULL`),
 * so a historical row behaves byte-for-byte as it did under the old
 * kind-only policy.
 */
export function deriveActionFromKind(kind: FailureKind): FailureAction {
  switch (kind) {
    case 'code':
      return 'terminal';
    case 'transient-cc':
      return 'failover';
    default:
      return 'retry';
  }
}

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
 * Classify a failure into code / infra / transient-cc / timeout plus the
 * policy `action` (terminal / quarantine / failover / retry) callers must
 * obey instead of re-deriving retryability themselves, a short
 * human-readable reason, and an optional Retry-After timestamp. Always
 * returns a verdict — never throws, never `unknown`.
 *
 * Match order: structured `meta.error.type` → runner token → the three
 * pre-spawn verdicts (TERMINAL_INFRA / PREFLIGHT / BOX_SATURATION /
 * REPO_CONTENTION, all above the cc-startup signal) → spend-cap →
 * usage/session limit → stopped on a question (terminal) → cc-startup signal → PERMISSION (infra) →
 * DUPLEX_SESSION (infra) → TIMEOUT → PERMANENT (code) → TRANSIENT (infra) →
 * CC_STARTUP text fallback → infra + needsReview. Permission/timeout precede
 * the broader buckets because their patterns are more specific.
 */
export function classifyFailure(input: ClassifyInput): ClassifyResult {
  const text = (input.error ?? '').trim();
  const meta = input.meta ?? null;
  const retryAfter = extractRetryAfter(meta);
  const { kind, reason, meta: resultMeta, action, cause } = classifyKind(text, meta, input.signals);
  const reviewedMeta =
    cause === 'unclassified' ? { ...(resultMeta ?? {}), needsReview: true } : resultMeta;
  return {
    kind,
    cause,
    action: action ?? deriveActionFromKind(kind),
    reason,
    meta: reviewedMeta,
    version: CLASSIFIER_VERSION,
    retryAfter,
  };
}

type KindVerdict = {
  kind: FailureKind;
  cause: FailureCause;
  reason: string;
  meta: Record<string, unknown> | null;
  action?: FailureAction;
};

const META_ERROR_KIND: Record<string, FailureKind> = {
  authentication_error: 'infra',
  permission_error: 'infra',
  invalid_request_error: 'code',
  billing_error: 'code',
  rate_limit_error: 'infra',
  overloaded_error: 'infra',
  api_error: 'infra',
};

/** A text-pattern bucket: `cause` null reads the cause off the text itself. */
type PatternRule = {
  patterns: readonly RegExp[];
  kind: FailureKind;
  cause: FailureCause | null;
  fallback: string;
  action?: FailureAction;
};

const rule = (
  patterns: readonly RegExp[],
  kind: FailureKind,
  cause: FailureCause | null,
  fallback: string,
  action?: FailureAction,
): PatternRule => ({ patterns, kind, cause, fallback, ...(action ? { action } : {}) });

/** The pre-spawn verdicts, which outrank the cc-startup signal. */
const PRE_SPAWN_RULES: readonly PatternRule[] = [
  rule(
    TERMINAL_INFRA_PATTERNS,
    'infra',
    'workspace_preflight_failed',
    'workspace preflight (pattern match)',
    'terminal',
  ),
  rule(
    PREFLIGHT_PATTERNS,
    'infra',
    'workspace_preflight_failed',
    'workspace preflight (pattern match)',
  ),
  rule(
    BOX_SATURATION_PATTERNS,
    'infra',
    'box_session_saturated',
    'box session permits saturated',
    'failover',
  ),
  rule(
    REPO_CONTENTION_PATTERNS,
    'infra',
    'repo_root_contention',
    'repo root held by a sibling job',
  ),
];

/** The message buckets after the cc-startup signal, most specific first. */
const MESSAGE_RULES: readonly PatternRule[] = [
  rule(PERMISSION_PATTERNS, 'infra', null, 'permission (pattern match)'),
  rule(DUPLEX_SESSION_PATTERNS, 'infra', 'duplex_channel_failed', 'duplex session channel failure'),
  rule(TIMEOUT_PATTERNS, 'timeout', null, 'timeout (pattern match)'),
  rule(PERMANENT_PATTERNS, 'code', null, 'permanent (pattern match)'),
  rule(TRANSIENT_PATTERNS, 'infra', null, 'transient (pattern match)'),
  rule(
    CC_STARTUP_PATTERNS,
    'transient-cc',
    'agent_skill_missing',
    'cc-startup-death (pattern match)',
  ),
];

function firstRule(
  rules: readonly PatternRule[],
  text: string,
  base: { textCause: FailureCause; reasonExcerpt: string; meta: Record<string, unknown> | null },
): KindVerdict | null {
  const hit = rules.find((r) => r.patterns.some((pat) => pat.test(text)));
  if (!hit) return null;
  return {
    kind: hit.kind,
    cause: hit.cause ?? base.textCause,
    reason: base.reasonExcerpt || hit.fallback,
    meta: base.meta,
    ...(hit.action ? { action: hit.action } : {}),
  };
}

function classifyKind(
  text: string,
  meta: Record<string, unknown> | null,
  signals: ClassifyInput['signals'],
): KindVerdict {
  const reasonExcerpt = text.length > 200 ? `${text.slice(0, 197)}…` : text;
  const textCause = causeForText(text);
  const base = { textCause, reasonExcerpt, meta };

  const metaErrorType = readMetaErrorType(meta);
  const metaKind = metaErrorType ? META_ERROR_KIND[metaErrorType] : undefined;
  if (metaErrorType && metaKind) {
    return {
      kind: metaKind,
      cause: causeForMetaErrorType(metaErrorType) ?? textCause,
      reason: `${metaErrorType}: ${truncate(extractMetaMessage(meta) ?? reasonExcerpt, 150)}`,
      meta,
    };
  }

  const runnerKind = classifyRunnerToken(text);
  if (runnerKind) return { kind: runnerKind, cause: textCause, reason: reasonExcerpt, meta };

  if (isSpendLimitError(text)) {
    return {
      kind: 'transient-cc',
      cause: 'provider_spend_cap',
      reason: 'org/account spend limit → per-account failover with exhaustion memory',
      meta: { ...(meta ?? {}), limitScope: 'account-spend' },
    };
  }
  if (isUsageLimitError(text)) {
    return {
      kind: 'transient-cc',
      cause: 'provider_usage_limit',
      reason: 'usage/session limit → cross-device failover',
      meta,
    };
  }

  const preSpawn = firstRule(PRE_SPAWN_RULES, text, base);
  if (preSpawn) return preSpawn;

  // Before the startup signal: a pane job streams no events, so that signal reads every one of
  // them as a death before its first tool. A rerun of the same prompt asks the same question,
  // so this fails terminal with the runner's sentence instead of retrying blind.
  if (STOPPED_ON_QUESTION_PATTERNS.some((p) => p.test(text))) {
    return {
      kind: 'code',
      cause: 'agent_stopped_on_question',
      reason: `stopped on a question → no retry: ${truncate(text.replace(/^stopped on a question:\s*/i, ''), 170)}`,
      meta,
      action: 'terminal',
    };
  }

  if (signals?.diedBeforeFirstToolUse === true && (signals.sessionMessageCount ?? 0) <= 3) {
    return {
      kind: 'transient-cc',
      cause: 'agent_startup_failed',
      reason: 'cc-startup-death (≤3 msgs, no tool use)',
      meta,
    };
  }

  return (
    firstRule(MESSAGE_RULES, text, base) ?? {
      kind: 'infra',
      cause: textCause,
      reason: reasonExcerpt || 'unclassified',
      meta: { ...(meta ?? {}), needsReview: true },
    }
  );
}

/**
 * ISS-479 — map an explicit forge-runner-core failureReason token to a kind.
 * Returns null when no runner token is present (incl. [RESULT_ERROR], whose
 * detail is left to the message patterns).
 */
function classifyRunnerToken(text: string): FailureKind | null {
  if (text.includes('[MCP_INIT_FAILED]') || text.includes('[SIGNAL_KILLED]')) {
    return 'infra';
  }
  if (text.includes('[NO_RESULT_CLEAN_EXIT]') || text.includes('[NO_RESULT_EXIT]')) {
    return 'transient-cc';
  }
  return null;
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
