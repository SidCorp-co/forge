// The one durable outbox (pattern v2, BC-18; ADR 0008): every fact another module reacts to is one of
// these events, written to `pipeline_outbox` in the transaction of the act it reports and delivered
// to its consumers by the outbox worker. A type is listed only while a consumer reads it.

import type { FeedbackSeverity } from "./feedback.js";
import type { MachineEntity, StateOf } from "./machines.js";

export const OUTBOX_EVENT_TYPES = [
	"issue.created",
	"issue.updated",
	"issue.transitioned",
	"issue.dependency.changed",
	"job.transitioned",
	"run.transitioned",
	"comment.created",
	"comment.updated",
	"comment.deleted",
	"comment.mentioned",
	"question.answered",
	"notification.created",
	"notification.read",
	"user.preferencesChanged",
	"skill.syncRequested",
	"runner.provisionRequested",
	"runner.provisionStatus",
	"source.pushed",
	"source.merged",
	"source.reviewed",
	"integration.changed",
	"workflow.designDecided",
	"channel.documentPublished",
	"channel.gateAsked",
	"channel.gateDecided",
	"channel.threadHeld",
	"contract.versionApproved",
	"contract.requested",
	"ecosystem.buildOwed",
	"requirement.agreed",
	"requirement.delivered",
	"requirement.accepted",
	"feedback.filed",
	"feedback.verifyAsked",
	"feedback.verifySettled",
	"credential.tokenChanged",
	"runner.changed",
	"job.changed",
	"job.eventsAppended",
	"session.changed",
] as const;
export type OutboxEventType = (typeof OUTBOX_EVENT_TYPES)[number];

/**
 * The route a merge stamp arrived by (github-merge-sequence `m-stamp`): the host's webhook
 * (`event`), Forge's own merge (`kernel`), a mark whose commit Forge read from the repository or its
 * record of the pull request (`repository`), or a mark resting on its writer's word (`mark`).
 */
export const MERGE_STAMP_VIAS = [
	"event",
	"kernel",
	"repository",
	"mark",
] as const;
export type MergeStampVia = (typeof MERGE_STAMP_VIAS)[number];

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
		/** Set by the merge stamp alone: the route the merge arrived by. */
		via?: MergeStampVia;
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
	/** An edge between two issues was added, changed (retracted or re-reasoned) or removed. */
	"issue.dependency.changed": {
		projectId: string;
		fromIssueId: string;
		toIssueId: string;
		kind: "blocks" | "relates" | "duplicates" | "parent" | "decomposes";
		change: "added" | "updated" | "removed";
	};
	"question.answered": {
		questionId: string;
		projectId: string;
		issueId: string | null;
		answeredBy: string;
		body: string;
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
	/** A channel document was published, at submit or by its gate's approval; `projectId` is the side that sent it. */
	"channel.documentPublished": {
		projectId: string;
		documentId: string;
		number: string | null;
		subject: string;
		type: string;
		to: string[];
		/** The person who wrote it, who is not told of their own document; null when an agent wrote it. */
		authorPersonId: string | null;
	};
	/** A submitted channel document waits at its sending side's approve gate. */
	"channel.gateAsked": {
		projectId: string;
		documentId: string;
		number: string | null;
		subject: string;
		type: string;
	};
	/** An admin approved or returned a channel document at its gate. */
	"channel.gateDecided": {
		projectId: string;
		documentId: string;
		number: string | null;
		subject: string;
		published: boolean;
		decidedBy: string | null;
		note: string | null;
	};
	/** A person on one side held or released a channel thread; `projectId` is that side, `parties` every side of the thread. */
	"channel.threadHeld": {
		projectId: string;
		ecosystemId: string;
		thread: string;
		action: "hold" | "release";
		byId: string;
		reason: string | null;
		parties: string[];
	};
	/** A provider approved a version of one of its contracts; `consumerIds` are the projects consuming it. */
	"contract.versionApproved": {
		projectId: string;
		providerSlug: string;
		contractSlug: string;
		version: string;
		classification: string;
		consumerIds: string[];
		filer: { userId: string; agency: "human" | "agent" };
	};
	/** Another project's contract request landed as a draft requirement here (E2); this project's master owes its triage. */
	"contract.requested": {
		projectId: string;
		requirementId: string;
		key: string;
		revision: number;
		requestedByProjectId: string;
		contract: string;
	};
	/** A builder run of this project is open (a join, a push, a supersede), and its master owes it. */
	"ecosystem.buildOwed": { projectId: string };
	/** A requirement was agreed, or re-agreed at a new head, and its master owes the breakdown. */
	"requirement.agreed": {
		projectId: string;
		requirementId: string;
		key: string;
		revision: number;
		baselineSeq: number;
	};
	/** A feedback item was filed, by a person or by core for a breaking contract version (E3). */
	"feedback.filed": {
		projectId: string;
		feedbackId: string;
		severity: FeedbackSeverity;
	};
	/** A holder of feedback.approve asked the reporter to verify a resolved item (feedback-triage `verify-ask`). */
	"feedback.verifyAsked": {
		projectId: string;
		feedbackId: string;
		key: string;
		title: string;
		reporter: string;
	};
	/** A resolved item was verified or reopened, which settles any ask to verify it. */
	"feedback.verifySettled": {
		projectId: string;
		feedbackId: string;
		key: string;
		decision: "verified" | "reopened";
	};
	/** A linked issue's move left the requirement reading delivered at `revision`; its BA owes the check. */
	"requirement.delivered": {
		projectId: string;
		requirementId: string;
		key: string;
		title: string;
		revision: number;
	};
	/** A holder of requirements.approve accepted the delivered revision. */
	"requirement.accepted": {
		projectId: string;
		requirementId: string;
		key: string;
		revision: number;
		acceptedBy: string;
	};
	/** A personal access token of `userId` was minted, revoked, or used (at most once a minute). */
	"credential.tokenChanged": {
		userId: string;
		tokenId: string;
		change: "created" | "revoked" | "used";
		ts: string;
	};
	/** A runner row changed; `data` is what its rooms are told, `runnerRoom` whether the runner's own room is too. */
	"runner.changed": {
		projectId: string;
		runnerId: string;
		event:
			| "runner.created"
			| "runner.updated"
			| "runner.deleted"
			| "runner.status";
		data: Record<string, unknown>;
		runnerRoom: boolean;
	};
	/** A job moved, or its box is asked to stop it; `rooms` names who is told. */
	"job.changed": {
		projectId: string;
		jobId: string;
		deviceId: string | null;
		event:
			| "job.cancelled"
			| "job.cancel"
			| "job.cancelRequested"
			| "job.failed"
			| "job.completed"
			| "job.resumed";
		data: Record<string, unknown>;
		rooms: ReadonlyArray<"project" | "device">;
	};
	/** One batch of a job's event lines was stored, scrubbed, in seq order. */
	"job.eventsAppended": {
		projectId: string;
		jobId: string;
		events: Array<{ seq: number; kind: string; ts: string; data: unknown }>;
	};
	/** An agent session was opened or changed status; told to its project's room and its box's. */
	"session.changed": {
		sessionId: string;
		projectId: string;
		deviceId: string | null;
		event: string;
		extra: Record<string, unknown>;
	};
}

export type OutboxEventPayload<T extends OutboxEventType> =
	OutboxEventPayloads[T];
