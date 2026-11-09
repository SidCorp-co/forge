// Who consumes each outbox event, and what one delivery looks like (pattern v2, BC-18; ADR 0008).
// The emitting transaction sends one pg-boss job per consumer named here, each on that consumer's
// own queue, so the list is data every process reads the same way, whether or not it runs the
// workers. The workers refuse to start when a registered consumer and this list disagree.

import type { OutboxEventType } from "./outbox-events.js";

export const OUTBOX_CONSUMERS = {
	"issue.created": [
		"ws-broadcast",
		"org-activity",
		"activity-feed",
		"master-wake",
		"memory-indexer",
		"support-results",
	],
	// an issue's move or stamp also refreshes what runs on its project now: the step it moved is
	// derived from it, never told beside it (ISS-1181)
	"issue.updated": [
		"ws-broadcast",
		"org-activity",
		"activity-feed",
		"memory-indexer",
	],
	"issue.transitioned": [
		"ws-broadcast",
		"org-activity",
		"activity-feed",
		"master-wake",
		"notify-transitions",
		"memory-reconcile",
		"issue-move-reactions",
		"steward",
		"support-results",
	],
	"issue.dependency.changed": ["ws-broadcast", "dependency-health"],
	"issue.landedWorkLeft": ["master-wake"],
	"job.transitioned": ["phase-journal-close", "memory-extraction", "steward"],
	"run.transitioned": [
		"paused-run-wedge-resolve",
		"release-batch-claims",
		"run-status-broadcast",
		"org-activity",
		"release-highlights",
		"release-naming",
	],
	"comment.created": ["activity-feed", "master-wake", "ws-broadcast"],
	"comment.updated": ["activity-feed", "ws-broadcast"],
	"comment.deleted": ["activity-feed", "ws-broadcast"],
	"comment.mentioned": ["activity-feed", "notify-mentions"],
	// an answer is told once, by its own event, never also as the question's move (ISS-1181)
	"question.answered": [
		"answer-resume",
		"master-wake",
		"requirement-reason",
		"ws-broadcast",
		"org-activity",
	],
	"question.asked": ["ws-broadcast", "org-activity", "question-suggest"],
	"question.transitioned": ["ws-broadcast", "org-activity"],
	"notification.created": ["ws-broadcast"],
	"notification.read": ["ws-broadcast"],
	"user.preferencesChanged": ["ws-broadcast"],
	"skill.syncRequested": ["ws-broadcast"],
	"runner.provisionRequested": ["ws-broadcast"],
	"runner.provisionStatus": ["ws-broadcast"],
	"source.pushed": ["ecosystem-builder", "on-land-deploy"],
	"source.reviewed": ["review-note"],
	"integration.changed": ["ws-broadcast", "support-rooms"],
	"workflow.designDecided": [
		"master-wake",
		"first-requirements",
		"org-activity",
	],
	"channel.documentPublished": ["notify-ecosystem", "master-wake"],
	"channel.gateAsked": ["notify-ecosystem"],
	"channel.gateDecided": ["notify-ecosystem"],
	"channel.threadHeld": ["notify-ecosystem", "master-wake"],
	// the approval is the decision: it settles its approver's Needs you row (ISS-1181)
	"contract.versionApproved": [
		"notify-ecosystem",
		"master-wake",
		"ws-broadcast",
		"org-activity",
	],
	"contract.requested": ["master-wake"],
	"ecosystem.buildOwed": ["master-wake"],
	"requirement.created": ["intake-assistant"],
	// an agree, an accept and a delivery are each their act's one report of the move (ISS-1181)
	"requirement.agreed": [
		"master-wake",
		"steward",
		"notify-requirements",
		"support-results",
		"org-activity",
		"ws-broadcast",
	],
	"requirement.returned": ["master-wake", "org-activity"],
	"requirement.transitioned": [
		"notify-requirements",
		"support-results",
		"org-activity",
	],
	"requirement.delivered": [
		"notify-requirements",
		"support-results",
		"org-activity",
	],
	"requirement.accepted": [
		"notify-requirements",
		"support-results",
		"org-activity",
	],
	"feedback.filed": ["master-wake", "intake-assistant", "steward"],
	"intake.answered": ["intake-assistant"],
	"feedback.verifyAsked": ["notify-feedback"],
	"feedback.verifySettled": [
		"notify-feedback",
		"support-results",
		"org-activity",
	],
	"feedback.reporterTold": ["notify-feedback"],
	"release.cut": ["release-naming", "org-activity"],
	"release.shipped": [
		"notify-feedback",
		"steward",
		"master-wake",
		"support-results",
		"support-release-notes",
		"org-activity",
	],
	"release.committed": ["release-tag"],
	"release.approvalDecided": ["release-approval-wake", "org-activity"],
	"verdict.recorded": ["release-highlights", "issue-fail-reopen"],
	"credential.tokenChanged": ["ws-broadcast"],
	"runner.changed": ["ws-broadcast"],
	"job.changed": ["ws-broadcast"],
	"session.changed": ["ws-broadcast"],
	"device.pushed": ["ws-broadcast", "support-rooms"],
	// the workspace's Activity room is told by a delivery of its own (ISS-951): a failed org lookup
	// retries that leg alone, never the project frame beside it
	"session.pushed": ["ws-broadcast", "org-activity"],
	"issue.pushed": ["ws-broadcast"],
	"conversation.pushed": ["ws-broadcast"],
	"preview.transitioned": ["ws-broadcast", "org-activity"],
	// the corrections a lesson learns from (REQ-50 BC-1, `core/src/lessons/`)
	"mockup.transitioned": ["lessons-corrections", "org-activity"],
	"chat.replied": ["lessons-chat"],
	"room.replied": ["lessons-room"],
	// the steward's own triggers (REQ-48 BC-1, `core/src/steward/consumer.ts`)
	"suggestion.proposed": ["steward"],
	"standing.stuck": ["steward"],
	"standing.changed": ["steward"],
	"release.held": ["steward"],
	// a person's decision no other event reports, told to the workspace's Activity (ISS-1053) and to
	// the project's open pages, a triage's Feedback list among them (ISS-1131)
	"decision.settled": ["org-activity", "ws-broadcast"],
} as const satisfies {
	// an event nobody consumes is refused (ISS-822): `source.merged` was emitted by three adapters for
	// a year with `[]` here; an event with no consumer is not emitted, and leaves the registry
	readonly [T in OutboxEventType]: readonly [string, ...string[]];
};

export type OutboxConsumerOf<T extends OutboxEventType> =
	(typeof OUTBOX_CONSUMERS)[T][number];
export type OutboxConsumerName = OutboxConsumerOf<OutboxEventType>;

/** The event types one consumer reads. */
export type ConsumedBy<N extends OutboxConsumerName> = {
	[T in OutboxEventType]: N extends OutboxConsumerOf<T> ? T : never;
}[OutboxEventType];

export function consumersOfType(
	type: OutboxEventType,
): readonly OutboxConsumerName[] {
	return OUTBOX_CONSUMERS[type];
}

/**
 * How many times a delivery is started before it is dead, and the backoff between starts: pg-boss
 * doubles the delay from `OUTBOX_RETRY_DELAY_SECONDS` up to `OUTBOX_RETRY_DELAY_MAX_SECONDS`, each
 * drawn between the delay and twice it, so the last attempt lands roughly seven hours after the first.
 */
export const OUTBOX_MAX_ATTEMPTS = 15;
export const OUTBOX_RETRY_DELAY_SECONDS = 10;
export const OUTBOX_RETRY_DELAY_MAX_SECONDS = 60 * 60;

/** Delivered jobs, and events, are pruned after this many days. A dead delivery is never pruned. */
export const OUTBOX_RETENTION_DAYS = 7;

/** One dead delivery, as `GET …/outbox/dead` lists it. */
export interface DeadOutboxDelivery {
	id: string;
	eventId: string;
	type: OutboxEventType;
	consumer: string;
	projectId: string | null;
	issueId: string | null;
	attempts: number;
	lastError: string | null;
	/** ISO 8601: when the event was written, and when its last attempt failed. */
	createdAt: string;
	deadAt: string;
}

export interface DeadOutboxDeliveriesResponse {
	deliveries: DeadOutboxDelivery[];
	total: number;
}

export const OUTBOX_REFUSAL_CODES = ["OUTBOX_DELIVERY_NOT_DEAD"] as const;
export type OutboxRefusalCode = (typeof OUTBOX_REFUSAL_CODES)[number];

/** `POST …/outbox/deliveries/:id/replay`: the delivery is pending again with a fresh attempt count. */
export interface ReplayOutboxDeliveryResponse {
	act: "replayed";
	delivery: {
		id: string;
		status: "pending";
		consumer: string;
		eventId: string;
	};
}
