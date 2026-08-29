/**
 * The pattern tables `failure-classifier.ts` matches against, in two sets that
 * cut the same text along different lines.
 *
 * The POLICY tables (`PERMISSION_PATTERNS` … `CC_STARTUP_PATTERNS`) are grouped
 * by what the pipeline should DO — retry, fail over, go terminal — and moved
 * here verbatim from the classifier so that file stays inside the 500-line
 * budget once ISS-877's cause axis lands.
 *
 * The CAUSE rules are grouped by what actually HAPPENED, and they are a
 * separate ordered table rather than a `cause` field threaded through each
 * policy bucket, because the two groupings genuinely disagree:
 * `TRANSIENT_PATTERNS` alone spans a provider 429, a runner that went offline
 * and a workspace preflight — one policy, three causes. Attaching a single
 * cause to that bucket would have to pick one and be wrong about the rest.
 */

import { isSpendLimitError, isUsageLimitError } from '../runners/limit-detect.js';
import type { FailureCause } from './failure-causes.js';

export const PERMISSION_PATTERNS: ReadonlyArray<RegExp> = [
  /\b(401|403)\b/,
  /\bunauthorized\b/i,
  /\bforbidden\b/i,
  /\bpermission[ _-]?denied\b/i,
];

export const TIMEOUT_PATTERNS: ReadonlyArray<RegExp> = [
  /\btimeout\b/i,
  /\bETIMEDOUT\b/i,
  /no[ _-]?progress[ _-]?for[ _-]/i,
  /heartbeat[ _-]?(missing|stale)/i,
];

// cm:guard the permission and timeout subpatterns are deliberately absent from this table — each text must match exactly ONE policy bucket, and duplicating one here makes the winner depend on evaluation order rather than on specificity
export const PERMANENT_PATTERNS: ReadonlyArray<RegExp> = [
  /content[ _-]?filter(ing)?/i,
  /invalid_request_error/i,
  /\bvalidation[ _-]?error\b|\bschema[ _-]?error\b/i,
  /\bquota[ _-]?exceeded\b/i,
  /\bbilling[ _-]?(error|required)\b/i,
  /\bmissing_prompt_string\b/i,
  /\brunner_unsupported_type\b/i,
];

// cm:guard these are `infra` with a TERMINAL action, and the pair is the point — the DIAGNOSIS is the runner's workspace and the POLICY is "retrying cannot fix it". They were `code`, which is the same policy reached by lying about the cause: a human triaging a red job read "code" and went looking at a diff, when the fault was that /home/forge/projects/anhome was not a git repo (ubuntu1, 8 jobs on 2026-08-14). ISS-808's original reason still holds for the action — a project with no git repo by design (e.g. a storefront) can't fix these by retrying.
// cm:edge protocol -> packages/core/src/pipeline/failure-classifier.ts#deriveActionFromKind — that fallback maps kind->action for pre-ISS-823 rows and CANNOT express this pair; anything added here is invisible to it, so a historical row keeps its old verdict by design
export const TERMINAL_INFRA_PATTERNS: ReadonlyArray<RegExp> = [
  /\bpreflight[ _-]?failed:\s*origin_remote\b/i,
  /\bpreflight[ _-]?failed:\s*work_tree\b/i,
  /\bpreflight[ _-]?failed:\s*repo_path\b/i,
];

// cm:guard these three strings are the ONLY routing lever the duplex send path has (RFC 0003), and the bucket sits AHEAD of TIMEOUT on purpose: `session_ack_timeout` otherwise matches the generic /\btimeout\b/ and is diagnosed as a stalled agent, which is the opposite of the truth — the agent may be working fine and it is the CHANNEL that failed. Diagnosis `infra`, policy `retry`: a fresh session is the correct next move, and only a `gone` the kill gate has confirmed may dispatch one.
export const DUPLEX_SESSION_PATTERNS: ReadonlyArray<RegExp> = [
  /\bsession_send_failed\b/i,
  /\bsession_ack_timeout\b/i,
  /\bsession_checkpoint_deadline_exceeded\b/i,
];

export const TRANSIENT_PATTERNS: ReadonlyArray<RegExp> = [
  /\bECONN(RESET|REFUSED|ABORTED)\b/i,
  /\bEPIPE\b|\bnetwork[ _-]?error\b/i,
  /\b50[0-9]\b|\bservice[ _-]?unavailable\b|\bbad[ _-]?gateway\b/i,
  /\b429\b|\brate[ _-]?limit/i,
  /runner (offline|stale|disconnected)/i,
  /pg-?boss[ _-]?(error|timeout)/i,
  // cm:why ISS-451 (C5) — a pre-claim preflight failure (missing repo, bad git tree, unreachable push remote, missing hooks path) is an environment problem by construction, so it is `infra` even though it looks like a project error
  /\bpreflight[ _-]?failed\b/i,
];

// cm:guard ISS-450 — a TEXT fallback only, for callers that could not derive structured `signals`; prefer the signal, because a CLI that dies during startup retries uselessly on the SAME device and only `transient-cc` routes it to an immediate different-device failover
export const CC_STARTUP_PATTERNS: ReadonlyArray<RegExp> = [
  /\bunknown command\b/i,
  /skill[ _-]?registration/i,
];

interface CauseRule {
  cause: FailureCause;
  test: (text: string) => boolean;
}

const re =
  (pattern: RegExp) =>
  (text: string): boolean =>
    pattern.test(text);

/**
 * Ordered most-specific-first. The first rule whose test passes names the
 * cause; nothing matching leaves `unclassified`, which is a real member and is
 * counted, not a silent floor.
 *
 * `[RESULT_ERROR] error_during_execution` ALONE has no rule, and that is the
 * answer rather than a gap: the CLI reports an error and says nothing about it,
 * so there is no cause to record. Naming it would dress an absence up as a
 * diagnosis, which is the move this whole issue exists to undo. It is 7 of the
 * 8 rows that stay unclassified over 90 days of forge-beta failures; the 8th
 * says `API Error: Internal server error` with nothing to say whether the
 * provider or Forge served it, and guessing is the same error in the other
 * direction.
 *
 * A generic `timeout` deliberately has no rule. The named timeout hops
 * (`queue_timeout`, `heartbeat_timeout`, `no_client_ack`) are written as
 * literals by `jobs/loop-monitor.ts` and never reach this table, so a bare
 * "timed out" here is a cause nobody has diagnosed yet — recording it as
 * `unclassified` is the honest answer and puts it on the counted surface,
 * which is the whole point of the invariant.
 */
// cm:guard order is load-bearing: the runner's own tokens outrank message text, and `provider_spend_cap` must precede `provider_usage_limit` because a spend-cap message also names a reset window
export const CAUSE_RULES: ReadonlyArray<CauseRule> = [
  { cause: 'agent_startup_failed', test: (t) => t.includes('[MCP_INIT_FAILED]') },
  { cause: 'agent_killed', test: (t) => t.includes('[SIGNAL_KILLED]') },
  {
    // cm:why `Agent completed with errors` is the SAME failure as `[NO_RESULT_*]`, in the runner's older wording: `succeeded_opt.unwrap_or(false)` defaults a MISSING CLI result line to failure (see jobs/finalize-done.ts, which root-caused it). 1,231 live rows across 4 projects, 2026-05-04 → 2026-06-15 — the single largest signature that would otherwise read unclassified.
    cause: 'agent_exited_without_result',
    test: (t) =>
      t.includes('[NO_RESULT_CLEAN_EXIT]') ||
      t.includes('[NO_RESULT_EXIT]') ||
      /agent completed with errors/i.test(t),
  },
  { cause: 'agent_skill_missing', test: (t) => t.includes('[NO_WORK]') },
  { cause: 'provider_spend_cap', test: (t) => isSpendLimitError(t) || /spend limit/i.test(t) },
  { cause: 'provider_subscription_disabled', test: re(/organization has disabled/i) },
  {
    cause: 'provider_auth_expired',
    test: re(/oauth session expired|failed to authenticate|not logged in|please run \/login/i),
  },
  {
    cause: 'provider_usage_limit',
    test: (t) => isUsageLimitError(t) || /usage\/session limit/i.test(t),
  },
  {
    cause: 'provider_refused_request',
    test: re(
      /unrecognized_model|unknown model|violate[sd]? .{0,40}usage polic|content[ _-]?filter/i,
    ),
  },
  {
    cause: 'provider_overloaded',
    test: re(
      /\b529\b|\boverloaded\b|(connection (closed|lost)|response stalled) mid-(response|stream)|\b50[0-9]\b|service[ _-]?unavailable|bad[ _-]?gateway|\b429\b|rate[ _-]?limit|request timed out/i,
    ),
  },
  // cm:guard the classifier's own HARD-LITERAL verdicts are part of its input vocabulary and each needs a rule here — `agent-session-link.ts#deriveSessionFailure` feeds `jobs.failure_reason` (already a classifier `reason`) back in, so a literal with no matching rule drops the session lane silently to `unclassified`. That is what happened to 88 live rows carrying `cc-startup-death (≤3 msgs, no tool use)`: the job row named the cause and the session row said nothing, which is `job_failed` under a new label. The `reasonExcerpt || '…'` verdicts need nothing, because the excerpt IS the original text and round-trips by construction; only the three branches that overwrite the text with a sentence of their own do.
  // cm:edge lockstep -> packages/core/src/pipeline/failure-classifier.ts — a new or reworded literal `reason:` there (one not built from `reasonExcerpt`) needs its rule here in the same change
  { cause: 'agent_skill_missing', test: re(/cc-startup-death \(pattern match\)/i) },
  { cause: 'agent_startup_failed', test: re(/cc-startup-death/i) },
  { cause: 'workspace_disk_full', test: re(/no space left|\bENOSPC\b/i) },
  { cause: 'workspace_preflight_failed', test: re(/preflight[ _-]?failed/i) },
  {
    cause: 'duplex_channel_failed',
    test: re(/session_send_failed|session_ack_timeout|session_checkpoint_deadline_exceeded/i),
  },
  {
    cause: 'session_lost',
    test: re(/session_lost|agent session terminated without job completion/i),
  },
  {
    cause: 'runner_unreachable',
    test: re(
      /dispatch_unclaimed|dispatch not delivered|no open websocket|runner (offline|stale|disconnected)|has no repo path/i,
    ),
  },
  {
    cause: 'agent_startup_failed',
    test: re(
      /invalid mcp configuration|mcp config file not found|temp directory .{0,80}owned by uid/i,
    ),
  },
  { cause: 'agent_skill_missing', test: re(/unknown command|skill[ _-]?registration/i) },
  { cause: 'resume_failed', test: re(/\bresume_failed\b|no conversation found with session id/i) },
  { cause: 'runner_unsupported_type', test: re(/\brunner_unsupported_type\b/i) },
  { cause: 'forge_budget_exhausted', test: re(/\bmonthly_budget_exhausted\b/i) },
  {
    cause: 'provider_refused_request',
    test: re(/invalid_request_error|\bbilling[ _-]?(error|required)\b|\bquota[ _-]?exceeded\b/i),
  },
];

/** Map a structured `meta.error.type` from the provider stream to a cause. */
export function causeForMetaErrorType(metaErrorType: string): FailureCause | null {
  switch (metaErrorType) {
    case 'authentication_error':
    case 'permission_error':
      return 'provider_auth_expired';
    case 'invalid_request_error':
      return 'provider_refused_request';
    case 'billing_error':
      return 'provider_spend_cap';
    case 'rate_limit_error':
    case 'overloaded_error':
    case 'api_error':
      return 'provider_overloaded';
    default:
      return null;
  }
}

/** First matching rule, or `unclassified`. */
export function causeForText(text: string): FailureCause {
  for (const rule of CAUSE_RULES) {
    if (rule.test(text)) return rule.cause;
  }
  return 'unclassified';
}
