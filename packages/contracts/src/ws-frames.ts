// The frames a browser's WebSocket receives: the name core publishes to a room and the payload
// under it. Core's `ws/broadcast-subscribers.ts` turns outbox events into these frames, and web's
// `lib/ws/event-router.ts` switches on them. A payload lists what its publisher sends; a frame is
// listed only while web routes it.

import type { StateOf } from "./machines.js";
import type { JobChange, JobFrameName, OutboxEventPayload, RunnerChange } from "./outbox-events.js";

interface IssueRef {
	issueId: string;
	projectId: string;
}

interface CommentFrame extends IssueRef {
	commentId: string;
}

interface SessionFrame {
	sessionId: string;
	projectId: string | null;
	deviceId: string | null;
	issueId?: string | null;
	status?: string;
}

/** Every job.* frame names its project, so the project's run list can refresh. */
type JobFrames = { [E in JobFrameName]: JobChange };

/** Every runner.* frame names its project, so the project's runner list can refresh. */
type RunnerFrame = RunnerChange;

/** A blocker reached a terminal status and released the issues it held. */
export interface UnblockCascadeFrame {
	blockerId: string;
	blockerIssSeq: number | null;
	/** Named by the server: only it knows the project's issue prefix (ISS-992). */
	blockerDisplayId: string | null;
	dependents: { issueId: string; issSeq: number; displayId: string }[];
	overflow: number;
	at: string;
}

interface TokenFrame {
	tokenId: string;
	userId: string;
	ts: string;
}

export interface WsFramePayloads extends JobFrames {
	"issue.created": IssueRef & { actorId: string };
	"issue.updated": IssueRef & { fields: string[]; actorId: string };
	"issue.statusChanged": {
		issueId: string;
		from: StateOf<"issue">;
		to: StateOf<"issue">;
		actorId: string;
		reason: string | null;
		at: string;
	};
	"issue.pipelineHealth.changed": { issueId?: string; projectId?: string };
	"issue.unblockCascade": UnblockCascadeFrame;
	dependencyChanged: { fromIssueId: string; toIssueId: string };
	"comment.created": CommentFrame;
	"comment.updated": CommentFrame;
	"comment.deleted": CommentFrame;
	"conversation.progress": {
		conversationId: string;
		rev: number;
		entry: { id: string };
		replaced?: { draft: string };
	};
	"conversation.accepted": {
		conversationId: string;
		messageId: string;
		seq: number;
		clientToken: string | null;
	};
	"conversation.settled": { conversationId: string };
	"conversation.message": { conversationId: string };
	"agent-session.created": SessionFrame;
	"agent-session.updated": SessionFrame;
	"agent-session.status": SessionFrame;
	"agent-session.deleted": SessionFrame;
	"agent-session.turn.appended": SessionFrame;
	"agent-session.turn.edited": SessionFrame & { turnId: string };
	"agent-session.turn.truncated": SessionFrame & { fromTurnIndex: number };
	"session.recoveryChanged": { sessionId: string; recoveryStats: unknown };
	"job.event": {
		jobId: string;
		projectId: string;
		seq: number;
		kind: string;
		ts: string;
		data: unknown;
	};
	"pipeline_run.status_changed": {
		runId: string;
		projectId: string;
		issueId: string | null;
		status: StateOf<"run">;
	};
	"device.statusChanged": { deviceId: string };
	"device.login": Record<string, unknown>;
	"device.paired": { deviceId: string };
	"device.revoked": { deviceId: string };
	"runner.provision": OutboxEventPayload<"runner.provisionStatus">;
	"runner.created": RunnerFrame;
	"runner.status": RunnerFrame;
	"runner.updated": RunnerFrame;
	"runner.deleted": RunnerFrame;
	"user.preferencesChanged": OutboxEventPayload<"user.preferencesChanged">;
	"notification.created": Omit<
		OutboxEventPayload<"notification.created">,
		"announce" | "body" | "secondaryIssueId" | "resolutionKey"
	> & { announce: boolean; body: string | null; secondaryIssueId: string | null };
	"notification.read": OutboxEventPayload<"notification.read">;
	"integration.changed": OutboxEventPayload<"integration.changed">;
	"pat.created": TokenFrame;
	"pat.revoked": TokenFrame;
	"pat.used": TokenFrame;
}

export type WsFrameName = keyof WsFramePayloads;

/** One frame as it arrives: a name, its payload, and when the server sent it. */
export type WsFrame = {
	[E in WsFrameName]: { event: E; data: WsFramePayloads[E]; timestamp: string };
}[WsFrameName];
