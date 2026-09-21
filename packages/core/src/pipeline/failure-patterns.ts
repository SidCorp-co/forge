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

export const PERMANENT_PATTERNS: ReadonlyArray<RegExp> = [
  /content[ _-]?filter(ing)?/i,
  /invalid_request_error/i,
  /\bvalidation[ _-]?error\b|\bschema[ _-]?error\b/i,
  /\bquota[ _-]?exceeded\b/i,
  /\bbilling[ _-]?(error|required)\b/i,
  /\bmissing_prompt_string\b/i,
  /\brunner_unsupported_type\b/i,
];

export const TERMINAL_INFRA_PATTERNS: ReadonlyArray<RegExp> = [
  /\bpreflight[ _-]?failed:\s*origin_remote\b/i,
  /\bpreflight[ _-]?failed:\s*work_tree\b/i,
  /\bpreflight[ _-]?failed:\s*repo_path\b/i,
];

export const DUPLEX_SESSION_PATTERNS: ReadonlyArray<RegExp> = [
  /\bsession_send_failed\b/i,
  /\bsession_ack_timeout\b/i,
  /\bsession_checkpoint_deadline_exceeded\b/i,
];

export const BOX_SATURATION_PATTERNS: ReadonlyArray<RegExp> = [/\bsession_permit_saturated\b/i];

export const REPO_CONTENTION_PATTERNS: ReadonlyArray<RegExp> = [/\brepo_lock_timeout\b/i];

export const PREFLIGHT_PATTERNS: ReadonlyArray<RegExp> = [/\bpreflight[ _-]?failed\b/i];

export const TRANSIENT_PATTERNS: ReadonlyArray<RegExp> = [
  /\bECONN(RESET|REFUSED|ABORTED)\b/i,
  /\bEPIPE\b|\bnetwork[ _-]?error\b/i,
  /\b50[0-9]\b|\bservice[ _-]?unavailable\b|\bbad[ _-]?gateway\b/i,
  /\b429\b|\brate[ _-]?limit/i,
  /runner (offline|stale|disconnected)/i,
  /pg-?boss[ _-]?(error|timeout)/i,
];

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

export const CAUSE_RULES: ReadonlyArray<CauseRule> = [
  { cause: 'agent_startup_failed', test: (t) => t.includes('[MCP_INIT_FAILED]') },
  { cause: 'agent_killed', test: (t) => t.includes('[SIGNAL_KILLED]') },
  {
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
    cause: 'turn_never_reported',
    test: (t) => /prompt delivered/i.test(t) && /never reported submitting/i.test(t),
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
