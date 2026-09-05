/**
 * ISS-877 — the session/job failure taxonomy.
 *
 * `agent_sessions.failure_reason` held one value, `job_failed`, for every
 * agent-side failure, so the record said nothing (`VISION: state-never-lies`).
 * It also held free text: `session-failure.ts` wrote a human-readable sentence
 * into the same column `queue_timeout` uses as a token, which is why 55 live
 * rows carry prose — 9 of them the agent's own prompt. Two axes, two columns:
 * the sentence now goes to `failure_detail`.
 *
 * Derivation order was mandated, and reversing it is how the previous attempt
 * overreached. The first two causes come from the eight transcripts ISS-871
 * left undiagnosed (7 × `provider_spend_cap`, 1 × `provider_refused_request`);
 * every other member traces to a counted live signature or to a writer in this
 * codebase, named on its own line. Over 90 days of forge-beta failures (10,904
 * rows, 2026-08-29) 99.93% land on a named cause; `failure-patterns.ts` says
 * why the 8 detail-free rows keep no member.
 */

// cm:guard every member needs live rows or a named writer, and the line must say which — a cause nobody emits is indistinguishable from one nobody looked for, and it is what lets a taxonomy rot the way `job_failed` rotted
export const FAILURE_CAUSES = [
  /** org/account monthly spend cap. 4,412 jobs/60d; 7 of the 8 ISS-871 sessions. */
  'provider_spend_cap',
  /** weekly / session / 5-hour usage window. 153 jobs/60d; 20 sessions all-time. */
  'provider_usage_limit',
  /** "Your organization has disabled Claude subscription access". 283 jobs/60d. */
  'provider_subscription_disabled',
  /** OAuth expired, "Not logged in · Please run /login". 2,503 jobs/60d. */
  'provider_auth_expired',
  /** 429/5xx/529, connection closed or stalled mid-response. 54 jobs/60d. */
  'provider_overloaded',
  /** provider rejected the request itself — unrecognized model, content policy.
   *  2 jobs/60d, one of them session 1a950b18 (`[claude-code:unrecognized_model]`). */
  'provider_refused_request',
  /** the CLI spawned and died before doing anything — MCP init failed, missing
   *  MCP config, temp dir owned by another uid, or the ISS-450 startup-death
   *  signal (≤3 messages, no tool use). 120 jobs/90d, 88 of them the latter. */
  'agent_startup_failed',
  /** zero turns because the skill never reached the device. 72 jobs/60d (`[NO_WORK]`). */
  'agent_skill_missing',
  /** exited before emitting a result event. 1,249 jobs/90d — 18 as `[NO_RESULT_*]`
   *  and 1,231 in the runner's older wording, `Agent completed with errors`. */
  'agent_exited_without_result',
  /** killed by a signal. 1 job/60d (`[SIGNAL_KILLED]`). */
  'agent_killed',
  /** the chat lane's skill-sync race. Writer: agent-sessions/routes.ts. */
  'skill_not_synced',
  /** repo_path / work_tree / origin_remote preflight. 1,073 jobs/60d. */
  'workspace_preflight_failed',
  /** ENOSPC. 57 jobs/60d. */
  'workspace_disk_full',
  /** a sibling job held the runner's repo root past `REPO_LOCK_WAIT`. Writer:
   *  runner `daemon/dispatch.rs` (`repo_lock_timeout`); 7 rows in 30 minutes on
   *  forge-vm 2026-09-05, all read `unclassified` before ISS-920. */
  'repo_root_contention',
  /** the box's `duplex_max_sessions` permits were all held. Writer: runner
   *  `runner/claude_code.rs` (`session_permit_saturated`); new in ISS-920, which
   *  is also what made it nameable — before it, the same event surfaced on a
   *  DIFFERENT project's jobs as `repo_lock_timeout`. */
  'box_session_saturated',
  /** dispatch never delivered or never claimed. 54 jobs/60d. */
  'runner_unreachable',
  /** duplex send/ack/checkpoint failure (RFC 0003). Writer: pipeline/failure-classifier.ts. */
  'duplex_channel_failed',
  /** the session died without the job reporting. 160 jobs/60d. */
  'session_lost',
  /** heartbeat hop reaped it. 91 sessions all-time. */
  'heartbeat_timeout',
  /** nobody picked it up. 20 sessions all-time. */
  'queue_timeout',
  /** the ack hop reaped it. 7 sessions all-time. */
  'no_client_ack',
  /** the websocket publish that carries a chat turn failed. Writers:
   *  schedules/dispatch.ts, rocketchat/agent-chat.ts, rocketchat/escalation.ts. */
  'ws_publish_failed',
  /** project monthly budget. Writer: jobs/dispatcher.ts. */
  'forge_budget_exhausted',
  /** the runner cannot run this job type. 21 jobs all-time. */
  'runner_unsupported_type',
  /** a resume attempt failed, incl. the CLI having no such conversation to
   *  resume. Writer: jobs/lifecycle-routes.ts; 10 jobs/90d from the CLI side. */
  'resume_failed',
  /** duplex residency window elapsed. Writer: jobs/park-deadline.ts. */
  'residency_expired',
  /** a schedule run produced no evidence. Writer: agent-sessions/schedule-evidence.ts. */
  'audit_ran_blind',
  /** the I1 trigger reaped an active child under a terminal run. 101 sessions. */
  'orphan_under_terminal_run',
  /** run cancelled. 19 sessions, 98 jobs. */
  'pipeline_cancelled',
  /** run completed while a child was still active. 15 sessions, 172 jobs. */
  'pipeline_completed',
  /** run failed while a child was still active. 3 jobs. */
  'pipeline_failed',
  /** a migration swept a zombie row. 23 sessions. */
  'migration_zombie_cleanup',
  /** an operator cleared a stale chat/schedule session by hand. 16 sessions. */
  'manual_ops_stale_chat_schedule',
  /** a person cancelled it. 7 sessions. */
  'user_cancelled',
  /** nothing matched. First-class and counted, never a silent fallback. */
  'unclassified',
] as const;

export type FailureCause = (typeof FAILURE_CAUSES)[number];

export type FailureOrigin =
  | 'provider'
  | 'agent'
  | 'workspace'
  | 'transport'
  | 'forge'
  | 'lifecycle'
  | 'user'
  | 'unknown';

// cm:guard exhaustive by construction — `Record<FailureCause, …>` makes a new cause without an origin a compile error, which is the only thing stopping a member from silently counting as `unknown`
export const FAILURE_CAUSE_ORIGIN: Record<FailureCause, FailureOrigin> = {
  provider_spend_cap: 'provider',
  provider_usage_limit: 'provider',
  provider_subscription_disabled: 'provider',
  provider_auth_expired: 'provider',
  provider_overloaded: 'provider',
  provider_refused_request: 'provider',
  agent_startup_failed: 'agent',
  agent_skill_missing: 'agent',
  agent_exited_without_result: 'agent',
  agent_killed: 'agent',
  skill_not_synced: 'agent',
  workspace_preflight_failed: 'workspace',
  workspace_disk_full: 'workspace',
  repo_root_contention: 'workspace',
  box_session_saturated: 'forge',
  runner_unreachable: 'transport',
  duplex_channel_failed: 'transport',
  session_lost: 'transport',
  heartbeat_timeout: 'transport',
  queue_timeout: 'transport',
  no_client_ack: 'transport',
  ws_publish_failed: 'transport',
  forge_budget_exhausted: 'forge',
  runner_unsupported_type: 'forge',
  resume_failed: 'forge',
  residency_expired: 'forge',
  audit_ran_blind: 'forge',
  orphan_under_terminal_run: 'lifecycle',
  pipeline_cancelled: 'lifecycle',
  pipeline_completed: 'lifecycle',
  pipeline_failed: 'lifecycle',
  migration_zombie_cleanup: 'lifecycle',
  manual_ops_stale_chat_schedule: 'lifecycle',
  user_cancelled: 'user',
  unclassified: 'unknown',
};

/**
 * Values written before ISS-877 that must keep reading as something. Resolved
 * at READ time only — the 1,787 historical `job_failed` rows are NOT rewritten,
 * because `failure-classifier.ts` states that a historical row keeps its
 * original verdict, and because most of those rows no longer have a source to
 * derive a cause from. `job_failed` resolves to `unclassified` on purpose: it
 * IS the unclassified era, and pretending otherwise would trade an admitted
 * lie for a confident one.
 */
// cm:edge lockstep -> packages/contracts/src/failure-causes.ts — web-v2 cannot import this file (core is not on its dependency path) and core cannot VALUE-import contracts (the prod image ships no contracts package — see contracts-runtime-boundary.test.ts, and ISS-510's boot crash). So the list and this alias table exist TWICE on purpose, exactly as NOTIFICATION_TYPES does, and `failure-causes-parity.test.ts` is what keeps the copies identical. Edit both.
export const LEGACY_CAUSE_ALIAS: Readonly<Record<string, FailureCause>> = {
  job_failed: 'unclassified',
  usage_limit: 'provider_usage_limit',
  'ws-publish-failed': 'ws_publish_failed',
};

const CAUSE_SET: ReadonlySet<string> = new Set(FAILURE_CAUSES);
// cm:guard a Map, not the object literal — `raw` comes from a free-text column, and a plain object answers `toString`, `constructor` and `valueOf` off its PROTOTYPE, so a bare `LEGACY_CAUSE_ALIAS[raw]` hands back a function typed `FailureCause` for a row holding any of those words
const ALIAS_LOOKUP: ReadonlyMap<string, FailureCause> = new Map(Object.entries(LEGACY_CAUSE_ALIAS));

/**
 * Turn whatever is in `failure_reason` into a cause. Historic tokens go through
 * the alias table; free text and unknown tokens read `unclassified`.
 *
 * The write side is held by the TYPE, not by a runtime funnel and not by a
 * CHECK: `schema.ts` declares the column `text('failure_reason', { enum:
 * agentSessionFailureReasons })`, so a `set: { failureReason: someText }`
 * anywhere in core is a compile error. That is deliberate over a CHECK —
 * migration 0180 measured what one costs on this table family, where a single
 * missed writer turns every INSERT into a 23514 — and it is why nothing here
 * normalizes on write. Two things make it hold and both are load-bearing: the
 * `{ enum }` on the column, and `patchSchema` staying `.strict()` without a
 * `failureReason` field so no request body can supply one past the type.
 */
// cm:guard read the column through this, never by comparing the raw string — pre-ISS-877 rows carry `job_failed`, `usage_limit` and `ws-publish-failed`, and a literal comparison silently stops matching them
export function resolveFailureCause(raw: string | null | undefined): FailureCause {
  if (!raw) return 'unclassified';
  if (CAUSE_SET.has(raw)) return raw as FailureCause;
  return ALIAS_LOOKUP.get(raw) ?? 'unclassified';
}

/** Whether a cause names something that went wrong, as opposed to a lifecycle
 *  conclusion or a person pressing cancel. This is the METRIC question — for
 *  how a cause should read to an operator, which is a different question with
 *  different answers, see `FAILURE_CAUSE_PRESENTATION` in `@forge/contracts`. */
export function isRealFailureCause(cause: FailureCause): boolean {
  const origin = FAILURE_CAUSE_ORIGIN[cause];
  return origin !== 'lifecycle' && origin !== 'user';
}
