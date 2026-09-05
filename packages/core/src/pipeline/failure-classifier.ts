/**
 * Pipeline failure classifier.
 *
 * Maps a job-failure error string + optional structured metadata to a
 * `kind` (diagnosis) and an `action` (policy — terminal/quarantine/failover/
 * retry) that `scheduleAutoRetryWithVerify` obeys instead of re-deriving
 * retryability from `kind` itself.
 *
 * ISS-877 added a third axis: `cause` (what actually happened). It is derived
 * from the same text by the same call, so the job lane and the session lane can
 * never disagree about why a run died — `jobs/agent-session-link.ts` asks this
 * function instead of stamping the `job_failed` that used to stand for all of
 * them. Pattern tables live in `failure-patterns.ts`.
 *
 * `version` is bumped whenever the patterns below change semantically.
 * Persisted on `jobs.classifier_version` so that, when patterns evolve,
 * a re-classified historical row keeps its original verdict (the sweeper
 * reads jobs.failure_kind, never re-runs the classifier on archived
 * rows).
 */

import { isSpendLimitError, isUsageLimitError } from '../runners/limit-detect.js';
import type { FailureCause } from './failure-causes.js';
import {
  BOX_SATURATION_PATTERNS,
  CC_STARTUP_PATTERNS,
  causeForMetaErrorType,
  causeForText,
  DUPLEX_SESSION_PATTERNS,
  PERMANENT_PATTERNS,
  PERMISSION_PATTERNS,
  REPO_CONTENTION_PATTERNS,
  TERMINAL_INFRA_PATTERNS,
  TIMEOUT_PATTERNS,
  TRANSIENT_PATTERNS,
} from './failure-patterns.js';
import { parseRetryAfter, readRetryAfterHeader } from './retry-after-parser.js';

// cm:edge contract -> packages/runner/crates/forge-runner-core/src/runner/claude_code.rs — the runner's plain error string is its only routing lever
// cm:guard bump CLASSIFIER_VERSION on any pattern change, and keep specific buckets ahead of the transient fallthrough
export const CLASSIFIER_VERSION = 11;

export type FailureKind = 'code' | 'infra' | 'transient-cc' | 'timeout';

// cm:why quarantine is reserved for ISS-825 (deterministic box-broken detection); no rule in this classifier emits it yet
export type FailureAction = 'terminal' | 'quarantine' | 'failover' | 'retry';

export interface ClassifyResult {
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
 * Match order: structured `meta.error.type` → runner token →
 * BOX_SATURATION / REPO_CONTENTION (both above the cc-startup signal) → spend-cap →
 * usage/session limit → cc-startup signal → PERMISSION (infra) →
 * DUPLEX_SESSION (infra) → TIMEOUT →
 * TERMINAL_INFRA (infra, terminal) → PERMANENT (code) → TRANSIENT (infra) →
 * CC_STARTUP text fallback → infra + needsReview. Permission/timeout precede
 * the broader buckets because their patterns are more specific.
 */
export function classifyFailure(input: ClassifyInput): ClassifyResult {
  const text = (input.error ?? '').trim();
  const meta = input.meta ?? null;
  const retryAfter = extractRetryAfter(meta);
  const { kind, reason, meta: resultMeta, action, cause } = classifyKind(text, meta, input.signals);
  // cm:guard an `unclassified` cause MUST arrive with `meta.needsReview` — the operator's review queue reads the flag and the taxonomy metric reads the cause, so a row that is one without the other makes the unclassified rate and the queue disagree, and a hole nobody can see is how `job_failed` lasted 1,787 rows
  const reviewedMeta =
    cause === 'unclassified' ? { ...(resultMeta ?? {}), needsReview: true } : resultMeta;
  return {
    kind,
    cause,
    // cm:guard an explicit `action` from classifyKind MUST win — kind and action are two independent axes (diagnosis vs policy) and collapsing them is what forced `preflight_failed: work_tree` to be labelled `code` just to stop it retrying
    action: action ?? deriveActionFromKind(kind),
    reason,
    meta: reviewedMeta,
    version: CLASSIFIER_VERSION,
    retryAfter,
  };
}

function classifyKind(
  text: string,
  meta: Record<string, unknown> | null,
  signals: ClassifyInput['signals'],
): {
  kind: FailureKind;
  cause: FailureCause;
  reason: string;
  meta: Record<string, unknown> | null;
  action?: FailureAction;
} {
  const reasonExcerpt = text.length > 200 ? `${text.slice(0, 197)}…` : text;
  // cm:guard derive the cause ONCE, here, and let every branch below carry it — the policy buckets each span several causes (TRANSIENT alone covers a provider 429, an offline runner and a workspace preflight), so a per-branch cause would have to pick one and be wrong about the other two
  const textCause = causeForText(text);

  const metaErrorType = readMetaErrorType(meta);
  if (metaErrorType) {
    if (metaErrorType === 'authentication_error' || metaErrorType === 'permission_error') {
      return {
        kind: 'infra',
        cause: causeForMetaErrorType(metaErrorType) ?? textCause,
        reason: `${metaErrorType}: ${truncate(extractMetaMessage(meta) ?? reasonExcerpt, 150)}`,
        meta,
      };
    }
    if (metaErrorType === 'invalid_request_error' || metaErrorType === 'billing_error') {
      return {
        kind: 'code',
        cause: causeForMetaErrorType(metaErrorType) ?? textCause,
        reason: `${metaErrorType}: ${truncate(extractMetaMessage(meta) ?? reasonExcerpt, 150)}`,
        meta,
      };
    }
    if (
      metaErrorType === 'rate_limit_error' ||
      metaErrorType === 'overloaded_error' ||
      metaErrorType === 'api_error'
    ) {
      return {
        kind: 'infra',
        cause: causeForMetaErrorType(metaErrorType) ?? textCause,
        reason: `${metaErrorType}: ${truncate(extractMetaMessage(meta) ?? reasonExcerpt, 150)}`,
        meta,
      };
    }
  }

  // cm:guard the runner's token beats the message-count heuristic below, because the runner watched the process exit — an MCP-init death has no tool use and the heuristic calls that `transient-cc` (ISS-479). `[RESULT_ERROR]` returns null on purpose so the provider message in its detail still reaches the PERMANENT/TRANSIENT tables.
  const runnerKind = classifyRunnerToken(text);
  if (runnerKind) {
    return { kind: runnerKind, cause: textCause, reason: reasonExcerpt, meta };
  }

  // cm:guard the two pre-spawn verdicts are matched HERE, above the cc-startup signal, and moving either down makes it unreachable rather than merely late: a job that died in the repo-lock or permit wait never spawned, and the pre-spawn heartbeat leaves it looking exactly like a startup death to `deriveCcStartupSignals` (ISS-920).
  for (const pat of BOX_SATURATION_PATTERNS) {
    if (pat.test(text)) {
      return {
        kind: 'infra',
        action: 'failover',
        cause: 'box_session_saturated',
        reason: reasonExcerpt || 'box session permits saturated',
        meta,
      };
    }
  }

  for (const pat of REPO_CONTENTION_PATTERNS) {
    if (pat.test(text)) {
      return {
        kind: 'infra',
        cause: 'repo_root_contention',
        reason: reasonExcerpt || 'repo root held by a sibling job',
        meta,
      };
    }
  }

  // cm:why ISS-823 — org/account spend-cap is per-account (evidence: CLASSIFIER_VERSION 7), so it fails over with exhaustion memory instead of going terminal
  if (isSpendLimitError(text)) {
    return {
      kind: 'transient-cc',
      cause: 'provider_spend_cap',
      reason: 'org/account spend limit → per-account failover with exhaustion memory',
      meta: { ...(meta ?? {}), limitScope: 'account-spend' },
    };
  }

  // cm:guard after the runner tokens and before the cc-startup signal, both deliberately: `[MCP_INIT_FAILED]` must still win, and a limit error that also looks like a startup death must route to failover rather than to the same box (ISS-596).
  if (isUsageLimitError(text)) {
    return {
      kind: 'transient-cc',
      cause: 'provider_usage_limit',
      reason: 'usage/session limit → cross-device failover',
      meta,
    };
  }

  // cm:guard this branch is broad and it must stay BELOW every verdict that names a job which never spawned. `deriveCcStartupSignals` counts ALL job events, not assistant messages, so a heartbeat is enough to satisfy it — the pre-spawn beat put every ISS-920 permit and repo-lock failure through here. It sits above the text patterns on purpose (ISS-450: a generic error string from a real startup death must still reach immediate failover), which is why the two pre-spawn tables go above it rather than below.
  if (signals?.diedBeforeFirstToolUse === true && (signals.sessionMessageCount ?? 0) <= 3) {
    return {
      kind: 'transient-cc',
      cause: 'agent_startup_failed',
      reason: 'cc-startup-death (≤3 msgs, no tool use)',
      meta,
    };
  }

  for (const pat of PERMISSION_PATTERNS) {
    if (pat.test(text)) {
      return {
        kind: 'infra',
        cause: textCause,
        reason: reasonExcerpt || 'permission (pattern match)',
        meta,
      };
    }
  }

  for (const pat of DUPLEX_SESSION_PATTERNS) {
    if (pat.test(text)) {
      return {
        kind: 'infra',
        cause: 'duplex_channel_failed',
        reason: reasonExcerpt || 'duplex session channel failure',
        meta,
      };
    }
  }

  for (const pat of TIMEOUT_PATTERNS) {
    if (pat.test(text)) {
      return {
        kind: 'timeout',
        cause: textCause,
        reason: reasonExcerpt || 'timeout (pattern match)',
        meta,
      };
    }
  }

  for (const pat of TERMINAL_INFRA_PATTERNS) {
    if (pat.test(text)) {
      return {
        kind: 'infra',
        action: 'terminal',
        cause: 'workspace_preflight_failed',
        reason: reasonExcerpt || 'workspace preflight (pattern match)',
        meta,
      };
    }
  }

  for (const pat of PERMANENT_PATTERNS) {
    if (pat.test(text)) {
      return {
        kind: 'code',
        cause: textCause,
        reason: reasonExcerpt || 'permanent (pattern match)',
        meta,
      };
    }
  }

  for (const pat of TRANSIENT_PATTERNS) {
    if (pat.test(text)) {
      return {
        kind: 'infra',
        cause: textCause,
        reason: reasonExcerpt || 'transient (pattern match)',
        meta,
      };
    }
  }

  for (const pat of CC_STARTUP_PATTERNS) {
    if (pat.test(text)) {
      return {
        kind: 'transient-cc',
        cause: 'agent_skill_missing',
        reason: reasonExcerpt || 'cc-startup-death (pattern match)',
        meta,
      };
    }
  }

  // cm:why no POLICY bucket matched; `infra` is the conservative default (bounded retry) and `needsReview` puts the pattern gap on the operator UI instead of hiding it (I4 removed the `unknown` KIND, which is a different axis from the `unclassified` cause)
  // cm:guard carry `textCause` here rather than hard-coding `unclassified` — a POLICY gap and a CAUSE gap are different holes, and most texts that reach this branch (`dispatch_unclaimed`, `monthly_budget_exhausted`, `No space left on device`) have a perfectly well-known cause and merely no retry rule. Collapsing the two loses the diagnosis for exactly the failures nobody has written a policy for yet.
  return {
    kind: 'infra',
    cause: textCause,
    reason: reasonExcerpt || 'unclassified',
    meta: { ...(meta ?? {}), needsReview: true },
  };
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
