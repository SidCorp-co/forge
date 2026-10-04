
import { ISSUE_TERMINAL_STATUSES } from "@forge/contracts/issue-machine";
import { formatCountdown, formatElapsed } from "@/lib/utils/format";
import type { IssueStatus, PipelineHealth, PipelineReading, WaitingReason } from "./types";

export const STALE_AFTER_MS = 24 * 60 * 60 * 1000;

const SETTLED: ReadonlySet<IssueStatus> = new Set<IssueStatus>(ISSUE_TERMINAL_STATUSES);

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

/** A queued step's gate: core's reason and its reading (`issues/pipeline-health-reasons.ts`). */
export interface QueuedStepGate extends PipelineReading {
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
