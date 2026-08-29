/**
 * ISS-877 — the session failure taxonomy, as web-v2 sees it.
 *
 * `agent_sessions.failure_reason` held one value, `job_failed`, for every
 * agent-side death, so the record said nothing (`VISION: state-never-lies`).
 * The list below is what replaced it, and the derivation, the live counts and
 * the origin axis live with the WRITER, in core.
 *
 * This file is a deliberate second copy. Core cannot value-import this package
 * (its prod image does not ship it — ISS-510 took the API down that way, and
 * `contracts-runtime-boundary.test.ts` gates it since), and web-v2 cannot
 * import core. `NOTIFICATION_TYPES` has the same shape for the same reason.
 * What keeps the copies honest is `failure-causes-parity.test.ts` in core.
 */
// cm:edge lockstep -> packages/core/src/pipeline/failure-causes.ts — the canonical list; a cause added there and not here renders an operator a raw snake_case token, and one added here alone is a cause nothing writes

// cm:guard every member needs live rows or a named writer, and the line must say which — a cause nobody emits is indistinguishable from one nobody looked for, and it is what lets a taxonomy rot the way `job_failed` rotted
export const FAILURE_CAUSES = [
	/** org/account monthly spend cap. 4,412 jobs/60d; 7 of the 8 ISS-871 sessions. */
	"provider_spend_cap",
	/** weekly / session / 5-hour usage window. 153 jobs/60d; 20 sessions all-time. */
	"provider_usage_limit",
	/** "Your organization has disabled Claude subscription access". 283 jobs/60d. */
	"provider_subscription_disabled",
	/** OAuth expired, "Not logged in · Please run /login". 2,503 jobs/60d. */
	"provider_auth_expired",
	/** 429/5xx/529, connection closed or stalled mid-response. 54 jobs/60d. */
	"provider_overloaded",
	/** provider rejected the request itself — unrecognized model, content policy.
	 *  2 jobs/60d, one of them session 1a950b18 (`[claude-code:unrecognized_model]`). */
	"provider_refused_request",
	/** the CLI spawned and died before doing anything — MCP init failed, missing
	 *  MCP config, temp dir owned by another uid, or the ISS-450 startup-death
	 *  signal (≤3 messages, no tool use). 120 jobs/90d, 88 of them the latter. */
	"agent_startup_failed",
	/** zero turns because the skill never reached the device. 72 jobs/60d (`[NO_WORK]`). */
	"agent_skill_missing",
	/** exited before emitting a result event. 1,249 jobs/90d — 18 as `[NO_RESULT_*]`
	 *  and 1,231 in the runner's older wording, `Agent completed with errors`. */
	"agent_exited_without_result",
	/** killed by a signal. 1 job/60d (`[SIGNAL_KILLED]`). */
	"agent_killed",
	/** the chat lane's skill-sync race. Writer: agent-sessions/routes.ts. */
	"skill_not_synced",
	/** repo_path / work_tree / origin_remote preflight. 1,073 jobs/60d. */
	"workspace_preflight_failed",
	/** ENOSPC. 57 jobs/60d. */
	"workspace_disk_full",
	/** dispatch never delivered or never claimed. 54 jobs/60d. */
	"runner_unreachable",
	/** duplex send/ack/checkpoint failure (RFC 0003). Writer: pipeline/failure-classifier.ts. */
	"duplex_channel_failed",
	/** the session died without the job reporting. 160 jobs/60d. */
	"session_lost",
	/** heartbeat hop reaped it. 91 sessions all-time. */
	"heartbeat_timeout",
	/** nobody picked it up. 20 sessions all-time. */
	"queue_timeout",
	/** the ack hop reaped it. 7 sessions all-time. */
	"no_client_ack",
	/** the websocket publish that carries a chat turn failed. Writers:
	 *  schedules/dispatch.ts, rocketchat/agent-chat.ts, rocketchat/escalation.ts. */
	"ws_publish_failed",
	/** project monthly budget. Writer: jobs/dispatcher.ts. */
	"forge_budget_exhausted",
	/** the runner cannot run this job type. 21 jobs all-time. */
	"runner_unsupported_type",
	/** a resume attempt failed, incl. the CLI having no such conversation to
	 *  resume. Writer: jobs/lifecycle-routes.ts; 10 jobs/90d from the CLI side. */
	"resume_failed",
	/** duplex residency window elapsed. Writer: jobs/park-deadline.ts. */
	"residency_expired",
	/** a schedule run produced no evidence. Writer: agent-sessions/schedule-evidence.ts. */
	"audit_ran_blind",
	/** the I1 trigger reaped an active child under a terminal run. 101 sessions. */
	"orphan_under_terminal_run",
	/** run cancelled. 19 sessions, 98 jobs. */
	"pipeline_cancelled",
	/** run completed while a child was still active. 15 sessions, 172 jobs. */
	"pipeline_completed",
	/** run failed while a child was still active. 3 jobs. */
	"pipeline_failed",
	/** a migration swept a zombie row. 23 sessions. */
	"migration_zombie_cleanup",
	/** an operator cleared a stale chat/schedule session by hand. 16 sessions. */
	"manual_ops_stale_chat_schedule",
	/** a person cancelled it. 7 sessions. */
	"user_cancelled",
	/** nothing matched. First-class and counted, never a silent fallback. */
	"unclassified",
] as const;

export type FailureCause = (typeof FAILURE_CAUSES)[number];

/**
 * Values written before ISS-877 that must keep reading as something. Resolved
 * at READ time only — the 1,787 historical `job_failed` rows are NOT rewritten,
 * because `failure-classifier.ts` states that a historical row keeps its
 * original verdict, and because most of those rows no longer have a source to
 * derive a cause from. `job_failed` resolves to `unclassified` on purpose: it
 * IS the unclassified era, and pretending otherwise would trade an admitted
 * lie for a confident one.
 */
// cm:edge contract -> packages/web-v2/src/features/sessions/types.ts — that file renders these same strings; a key added here without its label/tooltip there shows an operator a raw token
export const LEGACY_CAUSE_ALIAS: Readonly<Record<string, FailureCause>> = {
	job_failed: "unclassified",
	usage_limit: "provider_usage_limit",
	"ws-publish-failed": "ws_publish_failed",
};

const CAUSE_SET: ReadonlySet<string> = new Set(FAILURE_CAUSES);

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
// cm:edge lockstep -> packages/core/src/db/schema.ts — the `{ enum: agentSessionFailureReasons }` on `agent_sessions.failure_reason` is the write-side half of this module; dropping it leaves the column plain `string` and re-opens the enum-mixed-with-free-text hole with nothing at runtime to catch it
export function resolveFailureCause(
	raw: string | null | undefined,
): FailureCause {
	if (!raw) return "unclassified";
	if (CAUSE_SET.has(raw)) return raw as FailureCause;
	return LEGACY_CAUSE_ALIAS[raw] ?? "unclassified";
}

export type FailureCausePresentation = "cleanup" | "swept" | "failure";

/**
 * How a cause should READ to an operator, which is a different question from
 * whether something went wrong and must not be answered by the same predicate.
 *
 * `isRealFailureCause` answers "did the fleet break" — a heartbeat timeout did,
 * and the failure metric counts it. The UI answers "is this the user's problem"
 * — the same timeout is automatic cleanup they need not act on, and ISS-322
 * settled that it reads neutral. Shipping one boolean for both questions is how
 * `residency_expired` came to be a real failure on one surface and a sweep on
 * the other in a single change.
 */
// cm:guard both surfaces derive from THIS map — web-v2 re-deriving its own neutral set from a hand-copied list of strings is exactly what let `no_client_ack` ship with no label at all
export const FAILURE_CAUSE_PRESENTATION: Record<
	FailureCause,
	FailureCausePresentation
> = {
	provider_spend_cap: "failure",
	provider_usage_limit: "failure",
	provider_subscription_disabled: "failure",
	provider_auth_expired: "failure",
	provider_overloaded: "failure",
	provider_refused_request: "failure",
	agent_startup_failed: "failure",
	agent_skill_missing: "failure",
	agent_exited_without_result: "failure",
	agent_killed: "failure",
	skill_not_synced: "failure",
	workspace_preflight_failed: "failure",
	workspace_disk_full: "failure",
	runner_unreachable: "failure",
	duplex_channel_failed: "failure",
	session_lost: "failure",
	heartbeat_timeout: "swept",
	queue_timeout: "swept",
	no_client_ack: "swept",
	ws_publish_failed: "failure",
	forge_budget_exhausted: "swept",
	runner_unsupported_type: "failure",
	resume_failed: "failure",
	residency_expired: "swept",
	audit_ran_blind: "failure",
	orphan_under_terminal_run: "cleanup",
	pipeline_cancelled: "cleanup",
	pipeline_completed: "cleanup",
	pipeline_failed: "cleanup",
	migration_zombie_cleanup: "cleanup",
	manual_ops_stale_chat_schedule: "cleanup",
	user_cancelled: "swept",
	unclassified: "failure",
};

/**
 * Strings that reach `failure_reason` on a live row without being causes. They
 * are the dispatcher's SKIP reasons (`jobs/dispatch-gates.ts`), which describe
 * why a job was not started rather than how a session died, plus one retired
 * spelling. They are NOT aliased into the taxonomy on purpose — a skipped
 * dispatch is not a failure and giving it a cause would put it in the failure
 * count — but the UI still meets them on old rows and must read them neutral
 * rather than showing a raw token.
 */
export const LEGACY_NEUTRAL_REASONS: ReadonlySet<string> = new Set([
	"issue_busy",
	"waiting_on_dep",
	"project_full",
	"runner_full",
	"no_worker_online",
]);
