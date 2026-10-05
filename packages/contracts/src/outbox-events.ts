// The one durable outbox (pattern v2, BC-18; ADR 0008): every fact another module reacts to is one of
// these events, written to `pipeline_outbox` in the transaction of the act it reports and delivered
// to its consumers by the outbox worker. A type is listed only while a consumer reads it.

import type { MachineEntity, StateOf } from "./machines.js";

export const OUTBOX_EVENT_TYPES = [
	"issue.created",
	"issue.updated",
	"issue.transitioned",
	"job.transitioned",
	"run.transitioned",
	"comment.created",
	"comment.updated",
	"comment.deleted",
	"comment.mentioned",
	"question.answered",
	"schedule.fired",
	"notification.created",
	"notification.read",
	"user.preferencesChanged",
	"skill.syncRequested",
	"skill.globalUpdated",
	"runner.provisionRequested",
	"runner.provisionStatus",
	"source.pushed",
	"source.merged",
	"source.reviewed",
	"integration.changed",
	"workflow.designDecided",
] as const;
export type OutboxEventType = (typeof OUTBOX_EVENT_TYPES)[number];

/** Who acted. A runner box, the sweeper or the system records as a device, always an agent. */
export interface OutboxActor {
	type: "user" | "device";
	id: string;
	agency: "human" | "agent";
}

/**
 * The machines whose kernel moves are events, and the target states that are. `"every"` emits each
 * move; a list emits only moves into those states. A machine absent here emits nothing: its moves
 * are recorded in `kernel_transitions` and no module reacts to them.
 */
export const TRANSITION_EVENTS = {
	issue: "every",
	job: ["done", "failed"],
	run: "every",
} as const satisfies {
	readonly [E in MachineEntity]?: "every" | readonly StateOf<E>[];
};
export type TransitionEventEntity = keyof typeof TRANSITION_EVENTS;

export function transitionEventType<E extends TransitionEventEntity>(
	entity: E,
): `${E}.transitioned` {
	return `${entity}.transitioned`;
}

export function emitsTransition(
	entity: string,
	to: string,
): entity is TransitionEventEntity {
	if (!Object.hasOwn(TRANSITION_EVENTS, entity)) return false;
	const which = TRANSITION_EVENTS[entity as TransitionEventEntity];
	return which === "every" || (which as readonly string[]).includes(to);
}

/** One kernel move, as `kernel_transitions` records it, with the row's project and issue. */
interface TransitionEvent<E extends TransitionEventEntity> {
	entity: E;
	id: string;
	projectId: string;
	/** The issue the row belongs to; for an issue move, the issue itself. */
	issueId: string | null;
	from: StateOf<E>;
	to: StateOf<E>;
	/** The version of the machine that judged the move; `from` and `to` are its states. */
	machineVersion: number;
	reason: string | null;
	actor: OutboxActor;
	/** When the move was written (ISO 8601). */
	at: string;
}

/** One error-tracker issue as the error-tracking port reads it; free text is already sanitised. */
export interface ErrorTrackerIssue {
	id: string;
	shortId: string | null;
	status: string | null;
	substatus: string | null;
	level: string | null;
	count: number | null;
	userCount: number | null;
	firstSeen: string | null;
	lastSeen: string | null;
	permalink: string | null;
	projectSlug: string | null;
	title: string | null;
	culprit: string | null;
	metadataValue: string | null;
}

/** The declared error-tracker target an issue was confined to. */
export interface ErrorTrackerTarget {
	label: string;
	organizationSlug: string;
	projectSlug?: string;
}

interface IssueSnapshot {
	title: string;
	description: string | null;
	descriptionFormat?: string;
	priority: string;
	category: string | null;
	reportedBy: string | null;
	assigneeId: string | null;
	labels: string[];
}

export interface OutboxEventPayloads {
	"issue.created": {
		issueId: string;
		projectId: string;
		actor: OutboxActor;
		status: StateOf<"issue">;
		snapshot: IssueSnapshot;
	};
	"issue.updated": {
		issueId: string;
		projectId: string;
		actor: OutboxActor;
		fields: string[];
		before: Record<string, unknown>;
		after: Record<string, unknown>;
	};
	"issue.transitioned": TransitionEvent<"issue">;
	"job.transitioned": TransitionEvent<"job">;
	"run.transitioned": TransitionEvent<"run">;
	"comment.created": {
		issueId: string;
		projectId: string;
		actor: OutboxActor;
		authored: "human" | "agent";
		commentId: string;
		body: string;
		parentId?: string | null;
	};
	"comment.updated": {
		issueId: string;
		projectId: string;
		actor: OutboxActor;
		commentId: string;
		before: string;
		after: string;
	};
	"comment.deleted": {
		issueId: string;
		projectId: string;
		actor: OutboxActor;
		commentId: string;
	};
	"comment.mentioned": {
		issueId: string;
		projectId: string;
		commentId: string;
		actor: OutboxActor;
		mentionedUserIds: string[];
	};
	"question.answered": {
		questionId: string;
		projectId: string;
		issueId: string | null;
		answeredBy: string;
		body: string;
	};
	"schedule.fired": {
		scheduleId: string;
		projectId: string;
		sessionId: string;
		actorUserId: string;
	};
	"notification.created": {
		notificationId: string;
		userId: string;
		/** False only for a record joining a grouped delivery somebody was already interrupted by. */
		announce?: boolean;
		projectId: string | null;
		type: string;
		title: string;
		body?: string | null;
		severity?: string | null;
		resolutionKey?: string | null;
		issueId: string | null;
		/** The actionable blocker or child of a dependency-stall wedge, beside the wedged `issueId`. */
		secondaryIssueId?: string | null;
		agentSessionId: string | null;
	};
	"notification.read": { notificationId: string; userId: string };
	"user.preferencesChanged": {
		userId: string;
		theme: string;
		language: string;
	};
	/** An explicit push: the one thing that tells a device to pull its skills. */
	"skill.syncRequested": {
		projectId: string;
		projectSlug: string;
		deviceIds: string[];
		skillNames: string[] | null;
		actorUserId: string;
	};
	"skill.globalUpdated": {
		name: string;
		oldVersion: number;
		newVersion: number;
		contentHash: string;
	};
	"runner.provisionRequested": {
		projectId: string;
		deviceId: string;
		runnerId: string;
	};
	"runner.provisionStatus": {
		projectId: string;
		runnerId: string;
		deviceId: string;
		status: string;
		detail: string | null;
	};
	/** A source host reported a push; `branch` is null where the ref named no branch. */
	"source.pushed": {
		projectId: string;
		bindingId: string;
		branch: string | null;
		commit: string | null;
		defaultBranch: string | null;
	};
	/** A source host reported a change request merged (on the host, not through Forge's merge). */
	"source.merged": {
		projectId: string;
		headRef: string;
		commitSha: string;
		/** ISO 8601. */
		mergedAt: string;
	};
	/** A review was submitted on a change request, on the host or through Forge. */
	"source.reviewed": {
		projectId: string;
		headRef: string;
		repository: string;
		number: number;
		review: {
			id: string;
			reviewer: string;
			state: string;
			submittedAt: string | null;
			url: string | null;
			body: string | null;
		};
	};
	/** A project's integration binding or connection changed; open views refetch them. */
	"integration.changed": {
		projectId: string;
		bindingId?: string;
		connectionId?: string;
	};
	/** The approver decided a design this project proposed: an approve unblocks its builds, a return owes a revision. */
	"workflow.designDecided": {
		projectId: string;
		workflowId: string;
		decision: "approve" | "return";
		issueId: string | null;
	};
}

export type OutboxEventPayload<T extends OutboxEventType> =
	OutboxEventPayloads[T];
