// Who consumes each outbox event, and what one delivery looks like (pattern v2, BC-18; ADR 0008).
// The emitting transaction sends one pg-boss job per consumer named here, each on that consumer's
// own queue, so the list is data every process reads the same way, whether or not it runs the
// workers. The workers refuse to start when a registered consumer and this list disagree.

import type { OutboxEventType } from "./outbox-events.js";

export const OUTBOX_CONSUMERS = {
	"issue.created": [
		"ws-broadcast",
		"activity-feed",
		"master-wake",
		"memory-indexer",
	],
	"issue.updated": ["ws-broadcast", "activity-feed", "memory-indexer"],
	"issue.transitioned": [
		"ws-broadcast",
		"activity-feed",
		"master-wake",
		"notify-transitions",
		"memory-reconcile",
		"issue-move-reactions",
	],
	"issue.dependency.changed": ["ws-broadcast", "dependency-health"],
	"job.transitioned": ["phase-journal-close", "memory-extraction"],
	"run.transitioned": ["paused-run-wedge-resolve", "release-batch-claims", "run-status-broadcast"],
	"comment.created": ["activity-feed", "master-wake"],
	"comment.updated": ["activity-feed"],
	"comment.deleted": ["activity-feed"],
	"comment.mentioned": ["activity-feed", "notify-mentions"],
	"question.answered": ["answer-resume", "master-wake"],
	"notification.created": ["ws-broadcast"],
	"notification.read": ["ws-broadcast"],
	"user.preferencesChanged": ["ws-broadcast"],
	"skill.syncRequested": ["ws-broadcast"],
	"runner.provisionRequested": ["ws-broadcast"],
	"runner.provisionStatus": ["ws-broadcast"],
	"source.pushed": ["ecosystem-builder", "live-reading"],
	"source.merged": ["issue-merge-stamp"],
	"source.reviewed": ["review-note"],
	"integration.changed": ["ws-broadcast"],
	"workflow.designDecided": ["master-wake"],
	"channel.documentPublished": ["notify-ecosystem", "master-wake"],
	"channel.gateAsked": ["notify-ecosystem"],
	"channel.gateDecided": ["notify-ecosystem"],
	"channel.threadHeld": ["notify-ecosystem", "master-wake"],
	"contract.versionApproved": ["notify-ecosystem", "master-wake"],
	"ecosystem.buildOwed": ["master-wake"],
} as const satisfies {
	readonly [T in OutboxEventType]: readonly string[];
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
