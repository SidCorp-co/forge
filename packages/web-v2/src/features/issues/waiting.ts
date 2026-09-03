// ISS-903 — the words the UI uses for "why this issue is not moving", in ONE
// place. Moved out of `derive.ts` when a second consumer appeared: the
// blocker banner (the long `reason`/`who` pair) and the queued-step panel plus
// the board/list chips (the short label) must not drift apart, and the gate
// vocabulary itself is owned by core's `PipelineWaitingReason`.
//
// cm:edge lockstep -> packages/core/src/issues/pipeline-health-types.ts — `PipelineWaitingReason` is the authority on which gates exist; a reason added there and missing from either record below stops compiling, which is the point

import { formatCountdown } from "@/lib/utils/format";
import type { PipelineHealth, WaitingReason } from "./types";

// cm:edge contract -> packages/core/src/jobs/hold.ts — mirrors AUTO_RELEASE_REASONS (`holdResumesItself`); a reason that changes lane there and not here tells the reader "no action needed" about a hold that is in fact waiting for them
const SELF_RESUMING_HOLD_REASONS = new Set([
	"all_devices_exhausted",
	"monthly_budget_exhausted",
	"verify_unavailable",
]);

/** Copy for a `job_held` wait, which depends on whether the hold clears itself. */
// cm:guard only the self-resuming half may say "no action" (RFC 0002) — a held step waiting on a MACHINE must not ask the reader to act, but `retry_rounds_exhausted` and `non_retryable_terminal` never clear on their own, and telling THOSE readers to sit tight is how a dead step outlives everyone's attention
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
	// cm:guard cancel BEFORE moving the issue — a held step occupies the issue-busy gate, so a transition made first cannot produce a replacement step and the issue looks stuck for a second reason
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
	// cm:guard these two must NOT say "no action" — unlike the capacity waits below, nothing clears them by itself: the run stays paused until someone resumes it and the pool stays empty until a host comes back. That silence is what let ISS-576/ISS-652 sit paused for 3 days and 11 jobs sit behind dead runners for up to 22.
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
	// cm:guard name the FIXED 60s inter-attempt wait, not a provider hint — `retry.ts` writes `retry_after_at` as `now + RETRY_COOLDOWN_MS` (or 0 on an immediate device failover) and nothing anywhere reads a Retry-After header into it, so copy about a provider quota sends the reader to a dashboard that has nothing to say about this wait
	retry_cooldown: {
		reason:
			"The step failed and is waiting out a 60-second cooldown before its next attempt.",
		who: "No action — the retry fires itself. If the attempts keep failing, read the step's error rather than waiting.",
	},
	// cm:guard this is the one queued reason that means the ISSUE is fine — the step answers a trigger the issue has already left, so the copy must not read as "your issue is blocked". Saying so would send the reader looking for a blocker that moved on by definition, which is the mislabel this reason was added to avoid.
	stale_trigger: {
		reason:
			"A queued step answers a trigger this issue has already moved past.",
		who: "No action — the step is discarded on the next dispatch sweep and the current stage takes over.",
	},
	waiting_on_dep: {
		reason:
			"Blocked by a dependency that hasn't merged to the base branch yet.",
		who: "Finish (and merge) the blocking issue first.",
	},
	waiting_on_decomp_children: {
		reason: "Waiting for its decomposed child issues to merge.",
		who: "The child issues must land on the base branch first.",
	},
	project_full: {
		reason: "The project's concurrency cap is reached.",
		who: "No action — dispatches when a slot frees.",
	},
	runner_full: {
		reason: "Every online runner is at capacity.",
		who: "No action — dispatches when a runner frees.",
	},
};


/** Chip-length labels for the board card and the issue-list row. Short enough
 *  to sit inside a status chip, and each one has to answer "so what do I do"
 *  in the same direction as its long twin above. */
export const WAITING_REASON_SHORT: Record<WaitingReason, string> = {
	issue_busy: "Another job active",
	job_held: "Step held",
	run_not_running: "Run paused",
	retry_cooldown: "Retry cooldown",
	stale_trigger: "Step superseded",
	waiting_on_dep: "Blocked by dep",
	waiting_on_decomp_children: "Waiting on children",
	project_full: "Project at cap",
	runner_stale: "No runner online",
	runner_full: "Runners at capacity",
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
// cm:guard read this and the `who` line as ONE decision — an amber attention chip over copy that says "no action" is a false alarm, and a calm chip over "resume the run" hides a wait that outlives everyone's attention. `job_held` is absent because its answer depends on the hold reason, exactly as `heldCopy` branches on it.
const GATE_NEEDS_ACTION: Record<Exclude<WaitingReason, "job_held">, boolean> = {
	issue_busy: false,
	run_not_running: true,
	retry_cooldown: false,
	stale_trigger: false,
	waiting_on_dep: true,
	waiting_on_decomp_children: true,
	project_full: false,
	runner_stale: true,
	runner_full: false,
};

function gateNeedsAction(reason: WaitingReason, holdReason: unknown): boolean {
	if (reason !== "job_held") return GATE_NEEDS_ACTION[reason];
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
			: WAITING_REASON_COPY[waitingOn.reason];
	if (!copy) return null;
	return {
		reason: waitingOn.reason,
		short: WAITING_REASON_SHORT[waitingOn.reason],
		detail: copy.reason,
		who: copy.who,
		needsAction: gateNeedsAction(waitingOn.reason, waitingOn.details?.holdReason),
	};
}

/**
 * The queued step to surface, or `null` when there is nothing to surface.
 *
 * A live session outranks it: the panel that shows a queued step is the SAME
 * panel that shows a running agent, and a running agent is the richer signal.
 */
// cm:guard returning null for a live session is what keeps the two renders mutually exclusive — the panel takes a discriminated union, so a caller that passed both would be choosing which lie to tell
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
