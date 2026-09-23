
import { statusesForLabels } from "@forge/contracts/issue-vocabulary";
import { formatCountdown, formatElapsed } from "@/lib/utils/format";
import type {
	IssueStatus,
	PauseResumer,
	PipelineHealth,
	WaitingReason,
} from "./types";

export const STALE_AFTER_MS = 24 * 60 * 60 * 1000;

const SETTLED = new Set<IssueStatus>(statusesForLabels("done", "dropped"));

/**
 * How long since the issue ROW itself was last written, graded against a caller-held instant so
 * every row in one render is comparable. It is NOT how long the issue has been at this status, and
 * NOT how long since anything happened to it; each surface showing it says which of the three it
 * is, because the three differ by hours on live rows.
 */
export function sinceLastWrite(
	row: { status: IssueStatus; updatedAt: string },
	now: number,
): { label: string; stale: boolean } | null {
	if (SETTLED.has(row.status)) return null;
	const since = new Date(row.updatedAt).getTime();
	if (Number.isNaN(since)) return null;
	const ms = Math.max(0, now - since);
	return { label: formatElapsed(ms), stale: ms >= STALE_AFTER_MS };
}

const SELF_RESUMING_HOLD_REASONS = new Set([
	"all_devices_exhausted",
	"monthly_budget_exhausted",
	"verify_unavailable",
]);

/** Copy for a `job_held` wait, which depends on whether the hold clears itself. */
export function heldCopy(holdReason: unknown): { reason: string; who: string } {
	if (
		typeof holdReason === "string" &&
		SELF_RESUMING_HOLD_REASONS.has(holdReason)
	) {
		return {
			reason:
				"A step is held: it could not run and is waiting for the condition to clear.",
			who: "No action — it resumes itself, and alerts if the hold outlives the condition.",
		};
	}
	return {
		reason:
			"A step is held: it could not run, and this hold does not clear on its own.",
		who: "Fix the cause, then cancel the step — the issue can only move on once it is cancelled.",
	};
}

export const WAITING_REASON_COPY: Record<
	WaitingReason,
	{ reason: string; who: string }
> = {
	issue_busy: {
		reason: "Another job is already active on this issue.",
		who: "Wait for the active run to finish.",
	},
	job_held: heldCopy(null),
	run_not_running: {
		reason:
			"The step is queued, but its pipeline run is paused or already closed — nothing will dispatch it.",
		who: "Resume the run (or cancel it and re-open the issue for a fresh one).",
	},
	runner_stale: {
		reason:
			"No runner is online for this project — every host is offline, stale, or rate-limited.",
		who: "Bring a runner back (check the Runners tab); the step dispatches on the next tick.",
	},
	retry_cooldown: {
		reason:
			"The step failed and is waiting out a 60-second cooldown before its next attempt.",
		who: "No action — the retry fires itself. If the attempts keep failing, read the step's error rather than waiting.",
	},
	runner_too_old: {
		reason:
			"Every online runner for this project is running a build too old to claim work.",
		who: "Update the runner on that host; the step dispatches on the next tick once it reports the new version.",
	},
};


export const WAITING_REASON_SHORT: Record<WaitingReason, string> = {
	issue_busy: "Another job active",
	job_held: "Step held",
	run_not_running: "Run paused",
	retry_cooldown: "Retry cooldown",
	runner_stale: "No runner online",
	runner_too_old: "Runner build too old",
};

/** Copy for a gate this build has no words for. Core owns the vocabulary and
 *  `WaitingReason` is a hand-mirror of it, so a newly added reason reaches this
 *  UI before the mirror does. */
export const UNKNOWN_GATE_COPY = {
	reason: "The step is queued behind a gate this page does not recognise.",
	who: "Read the step in the pipeline view — this UI is older than the gate holding it.",
};

/** One gate, in every register the UI needs. */
export interface GateView {
	reason: WaitingReason;
	short: string;
	detail: string;
	who: string;
	/** False when the gate clears itself, which is what the `who` line already
	 *  says in words. Drives the chip's colour, so the two cannot disagree. */
	needsAction: boolean;
}

/** Which gates never clear on their own. The `who` copy above already splits
 *  this way; this record is that same split in a form the chip can key on. */
const GATE_NEEDS_ACTION: Record<Exclude<WaitingReason, "job_held">, boolean> = {
	issue_busy: false,
	run_not_running: true,
	retry_cooldown: false,
	runner_stale: true,
	runner_too_old: true,
};

function gateNeedsAction(reason: WaitingReason, holdReason: unknown): boolean {
	if (reason !== "job_held") return GATE_NEEDS_ACTION[reason] ?? true;
	return !(
		typeof holdReason === "string" && SELF_RESUMING_HOLD_REASONS.has(holdReason)
	);
}

/** The queued step as the panel, the card and the row all read it. `gate` is
 *  `null` for a step that is merely awaiting its turn — which the surfaces MUST
 *  say out loud, so "queued" never reads as "stuck". */
export interface QueuedStepView {
	jobId: string;
	jobType: string;
	queuedAt: string;
	/** `formatCountdown` of the next attempt, or "" when none is known. */
	nextAttempt: string;
	gate: GateView | null;
}

export function gateView(waitingOn: PipelineHealth["waitingOn"]): GateView | null {
	if (!waitingOn) return null;
	const copy =
		waitingOn.reason === "job_held"
			? heldCopy(waitingOn.details?.holdReason)
			: (WAITING_REASON_COPY[waitingOn.reason] ?? UNKNOWN_GATE_COPY);
	return {
		reason: waitingOn.reason,
		short: WAITING_REASON_SHORT[waitingOn.reason] ?? "Waiting",
		detail: copy.reason,
		who: copy.who,
		needsAction: gateNeedsAction(waitingOn.reason, waitingOn.details?.holdReason),
	};
}

/** Whether an agent is executing under a session row right now — the question
 *  `deriveQueuedStep` asks, which three surfaces had answered differently. */
export function hasLiveAgentSession(
	agentStatus: string | null | undefined,
): boolean {
	return agentStatus === "running" || agentStatus === "queued";
}

/**
 * The queued step to surface, or `null` when there is nothing to surface.
 *
 * A live session outranks it: the panel that shows a queued step is the SAME
 * panel that shows a running agent, and a running agent is the richer signal.
 */
export function deriveQueuedStep(
	pipelineHealth: PipelineHealth | undefined,
	hasLiveSession: boolean,
): QueuedStepView | null {
	const step = pipelineHealth?.queuedStep;
	if (!step || hasLiveSession) return null;
	return {
		jobId: step.jobId,
		jobType: step.jobType,
		queuedAt: step.queuedAt,
		nextAttempt: formatCountdown(step.retryAfterAt),
		gate: gateView(pipelineHealth?.waitingOn),
	};
}

/** The StatusKey a queued step's chip wears: the attention tone only when the
 *  gate needs a human, the calm queued tone otherwise. */
export function queuedChipStatus(step: QueuedStepView): "waiting" | "queued" {
	return step.gate?.needsAction ? "waiting" : "queued";
}

/** One paused run, in the registers the banner needs. */
export interface PausedRunView {
	runId: string;
	reason: string;
	who: string;
	needsAction: boolean;
}

/** Copy for a paused run, keyed on WHO ends the pause and on nothing else. */
const PAUSED_RUN_COPY: Record<PauseResumer, { reason: string; who: string }> = {
	operator: {
		reason:
			"The pipeline run for this issue is paused. No step will dispatch while it is, whatever this issue's status says.",
		who: "Resume the run — nothing else will. Cancel it instead if the work should not continue.",
	},
	machine: {
		reason:
			"The pipeline run for this issue is paused, waiting for the condition that paused it to clear.",
		who: "No action — it resumes itself once the condition clears.",
	},
	sweeper: {
		reason:
			"The pipeline run for this issue is paused for a reason this build no longer has code for.",
		who: "No action — the sweeper frees it on its next tick. Resume it by hand only if it is still paused after that.",
	},
};

/** The pause as the banner reads it, or `null` when no run is paused. */
export function pausedRunView(
	pausedRun: PipelineHealth["pausedRun"],
): PausedRunView | null {
	if (!pausedRun) return null;
	const copy = PAUSED_RUN_COPY[pausedRun.resumer] ?? PAUSED_RUN_COPY.sweeper;
	const named = pausedRun.kind
		? `${copy.reason} It is held by ${pausedRun.kind}${pausedRun.detail ? ` at ${pausedRun.detail}` : ""}.`
		: `${copy.reason} An operator paused it.`;
	return {
		runId: pausedRun.runId,
		reason: named,
		who: copy.who,
		needsAction: pausedRun.resumer === "operator",
	};
}
