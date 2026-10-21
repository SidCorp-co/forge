
import { formatCountdown } from "@/lib/utils/format";
import type { PipelineHealth, PipelineReading, WaitingReason } from "./types";

/** A queued step's gate: core's reason and its reading (`issues/pipeline-health-reasons.ts`). */
interface QueuedStepGate extends PipelineReading {
	reason: WaitingReason;
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
	/** When the next attempt is due, for a surface that writes the countdown in its own language. */
	retryAfterAt: string | null;
	gate: QueuedStepGate | null;
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
		retryAfterAt: step.retryAfterAt ?? null,
		gate: pipelineHealth?.waitingOn
			? { reason: pipelineHealth.waitingOn.reason, ...pipelineHealth.waitingOn.reading }
			: null,
	};
}

/** The StatusKey a queued step's chip wears: the attention tone only when the
 *  gate needs a human, the calm queued tone otherwise. */
export function queuedChipStatus(step: QueuedStepView): "waiting" | "queued" {
	return step.gate?.needsAction ? "waiting" : "queued";
}
