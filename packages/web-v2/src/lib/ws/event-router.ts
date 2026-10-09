"use client";

import type { WsFrame } from "@forge/contracts/ws-frames";
import type { QueryClient } from "@tanstack/react-query";
import { invalidateThroughInFlight } from "./invalidate-through-inflight";
import { scheduleInvalidation } from "./invalidation-coalescer";

/** The Agents run list's root key (agents `RUNS_STANDING_ROOT`); a job or run move invalidates it. */
const RUNS_STANDING_ROOT = "runs-standing";

/**
 * Dispatch a WS event to React Query cache invalidations. Every key must
 * prefix one a feature hook declares: a key no query holds refreshes nothing,
 * and nothing says so.
 */
export function routeEvent(env: WsFrame, qc: QueryClient): void {
	if (isConversationFrame(env)) {
		routeConversation(env, qc);
		return;
	}
	if (isBoxFrame(env)) {
		routeBox(env, qc);
		return;
	}
	const { event, data } = env;
	switch (event) {
		case "issue.created":
		case "issue.updated": {
			scheduleInvalidation(qc, ["issues", "search"]);
			scheduleInvalidation(qc, ["issues", "standing"]);
			scheduleInvalidation(qc, ["needs-you"]);
			scheduleInvalidation(qc, ["attention"]);
			scheduleInvalidation(qc, ["pulse"]);
			if (data?.issueId) {
				scheduleInvalidation(qc, ["issue", data.issueId]);
				scheduleInvalidation(qc, ["activities", data.issueId]);
			}
			return;
		}
		case "issue.statusChanged": {
			scheduleInvalidation(qc, ["issues", "search"]);
			scheduleInvalidation(qc, ["issues", "standing"]);
			scheduleInvalidation(qc, ["needs-you"]);
			scheduleInvalidation(qc, ["project-status"]);
			scheduleInvalidation(qc, ["projects", "health"]);
			scheduleInvalidation(qc, ["pulse"]);
			scheduleInvalidation(qc, ["attention"]);
			if (data?.issueId) {
				scheduleInvalidation(qc, ["issue", data.issueId]);
				scheduleInvalidation(qc, ["activities", data.issueId]);
				scheduleInvalidation(qc, ["questions", data.issueId]);
			}
			return;
		}
		case "question.changed": {
			// A question moves the marker the Issues list, the needs-you rows and the issue banner read.
			scheduleInvalidation(qc, ["questions"]);
			scheduleInvalidation(qc, ["issues", "search"]);
			scheduleInvalidation(qc, ["issues", "standing"]);
			scheduleInvalidation(qc, ["needs-you"]);
			scheduleInvalidation(qc, ["project-status"]);
			scheduleInvalidation(qc, ["attention"]);
			if (data?.issueId) scheduleInvalidation(qc, ["issue", data.issueId]);
			return;
		}
		case "issue.pipelineHealth.changed": {
			scheduleInvalidation(qc, ["issues", "standing"]);
			if (data?.issueId) {
				scheduleInvalidation(qc, ["issue", data.issueId]);
			}
			if (data?.projectId) {
				scheduleInvalidation(qc, ["projects", data.projectId, "active-runners"]);
			}
			return;
		}
		case "comment.created":
		case "comment.updated":
		case "comment.deleted": {
			scheduleInvalidation(qc, ["attention"]);
			scheduleInvalidation(qc, ["pulse"]);
			if (data?.issueId) {
				scheduleInvalidation(qc, ["comments", data.issueId]);
				scheduleInvalidation(qc, ["activities", data.issueId]);
			}
			return;
		}
		case "agent-session.created":
		case "agent-session.updated":
		case "agent-session.status":
		case "agent-session.deleted": {
			scheduleInvalidation(qc, ["agent-sessions"]);
			scheduleInvalidation(qc, ["pulse"]);
			if (data?.sessionId) {
				scheduleInvalidation(qc, ["agent-session", data.sessionId]);
			}
			if (data?.issueId) {
				scheduleInvalidation(qc, ["activities", data.issueId]);
			}
			return;
		}
		case "agent-session.turn.appended":
		case "agent-session.turn.edited":
		case "agent-session.turn.truncated": {
			if (data?.sessionId) {
				scheduleInvalidation(qc, ["agent-session", data.sessionId, "turns"]);
				scheduleInvalidation(qc, ["agent-session", data.sessionId]);
			}
			return;
		}
		// A live preview moved (REQ-39): the issue's panel reads it again, and the lane read after an approval.
		case "preview.changed": {
			if (data?.issueId) scheduleInvalidation(qc, ["preview", data.issueId]);
			return;
		}
		// ISS-197 — recoveryStats refresh on the sessions panel.
		case "session.recoveryChanged": {
			scheduleInvalidation(qc, ["agent-sessions"]);
			if (data?.sessionId) {
				scheduleInvalidation(qc, ["agent-session", data.sessionId]);
			}
			return;
		}
		// A live log line; no screen holds a job's log, so it refreshes nothing.
		case "job.event":
			return;
		case "job.dispatched":
		case "job.completed":
		case "job.failed":
		case "job.resumed":
		case "job.cancelled":
		case "job.cancelRequested": {
			scheduleInvalidation(qc, ["admin", "ops"]);
			// ISS-307 — a job flipping to failed (incl. deploy) belongs in Attention's
			// failed-jobs bucket; refresh the cross-project inbox + rail count.
			scheduleInvalidation(qc, ["attention"]);
			scheduleInvalidation(qc, ["pulse"]);
			// the Agents run list (agents `runsKey`) and the runners the job held
			scheduleInvalidation(qc, [RUNS_STANDING_ROOT, data.projectId]);
			scheduleInvalidation(qc, ["projects", data.projectId, "active-runners"]);
			return;
		}
		case "pipeline_run.status_changed": {
			scheduleInvalidation(qc, ["pipeline-runs", "list"]);
			scheduleInvalidation(qc, ["admin", "ops"]);
			// Projects console (ISS-290): liveRuns / spend roll up from pipeline_runs.
			scheduleInvalidation(qc, ["projects", "health"]);
			scheduleInvalidation(qc, ["pulse"]);
			if (data?.runId) {
				scheduleInvalidation(qc, ["pipeline-run", data.runId]);
			}
			scheduleInvalidation(qc, [RUNS_STANDING_ROOT, data.projectId]);
			// The cancel cascade flips agent_sessions too.
			if (data?.status === "cancelled") {
				scheduleInvalidation(qc, ["agent-sessions"]);
			}
			// A run reaching a terminal status frees its runner — refresh the
			// active-runner snapshot so the busy → idle flip reflects live.
			scheduleInvalidation(qc, ["projects", data.projectId, "active-runners"]);
			return;
		}
		case "user.preferencesChanged": {
			scheduleInvalidation(qc, ["settings", "preferences"]);
			return;
		}
		case "notification.created":
		case "notification.read": {
			scheduleInvalidation(qc, ["notifications"]);
			scheduleInvalidation(qc, ["notifications-open"]);
			scheduleInvalidation(qc, ["settings", "notifications"]);
			// ISS-307 — unread @-mentions feed Attention's mentions bucket.
			scheduleInvalidation(qc, ["attention"]);
			scheduleInvalidation(qc, ["pulse"]);
			// ISS-597 — an invitation_received notification means a new pending
			// invite; refresh the pending list so the actionable item appears live.
			scheduleInvalidation(qc, ["invitations-pending"]);
			return;
		}
		case "dependencyChanged": {
			scheduleInvalidation(qc, ["issues", "search"]);
			scheduleInvalidation(qc, ["issues", "standing"]);
			scheduleInvalidation(qc, ["needs-you"]);
			for (const id of [data?.fromIssueId, data?.toIssueId]) {
				if (!id) continue;
				scheduleInvalidation(qc, ["issue", id, "dependencies"]);
				scheduleInvalidation(qc, ["issue", id]);
				scheduleInvalidation(qc, ["activities", id]);
			}
			return;
		}
		case "issue.unblockCascade":
		case "replay.done":
		case "subscribe.denied":
			return;
		case "integration.changed": {
			// ISS-401/C — a binding mutation (create/update/delete/rotate-secret/
			// confirm-prod-deploy) broadcasts this to the project room. Refresh the
			// project-facing bindings list + composed status, and the owner-scoped
			// connections list (keyed without a projectId). Connection-only mutations
			// do not emit (no owner WS room) — they self-invalidate client-side.
			if (data?.projectId) {
				scheduleInvalidation(qc, ["integrations", "list", data.projectId]);
				scheduleInvalidation(qc, ["integrations", "status", data.projectId]);
				scheduleInvalidation(qc, ["integrations", "mcp-preview", data.projectId]);
			}
			scheduleInvalidation(qc, ["integration-connections"]);
			return;
		}
		case "pat.created":
		case "pat.revoked":
		case "pat.used": {
			// ISS-160 — keep the /settings/tokens list in sync. `pat.used` is
			// throttled to 1/min/token, and still refreshes the last-used time.
			scheduleInvalidation(qc, ["settings", "tokens"]);
			return;
		}
		default: {
			// A frame no case names: logged in dev to surface missing wiring.
			if (process.env.NODE_ENV !== "production") {
				console.debug("[ws] unhandled event", event, data);
			}
		}
	}
}

const CONVERSATION_FRAMES = [
	"conversation.progress",
	"conversation.accepted",
	"conversation.settled",
	"conversation.message",
] as const;
type ConversationFrame = Extract<WsFrame, { event: (typeof CONVERSATION_FRAMES)[number] }>;

function isConversationFrame(env: WsFrame): env is ConversationFrame {
	return (CONVERSATION_FRAMES as readonly string[]).includes(env.event);
}

const BOX_FRAMES = [
	"device.statusChanged",
	"device.login",
	"device.paired",
	"device.revoked",
	"runner.provision",
	"runner.created",
	"runner.status",
	"runner.updated",
	"runner.deleted",
] as const;
type BoxFrame = Extract<WsFrame, { event: (typeof BOX_FRAMES)[number] }>;

function isBoxFrame(env: WsFrame): env is BoxFrame {
	return (BOX_FRAMES as readonly string[]).includes(env.event);
}

/** A device or runner moved: the box lists, the project's runners and the health that counts them. */
function routeBox(env: BoxFrame, qc: QueryClient): void {
	const { event, data } = env;
	switch (event) {
		case "device.statusChanged": {
			scheduleInvalidation(qc, ["devices", "me"]);
			scheduleInvalidation(qc, ["devices", "org"]);
			// Projects console (ISS-290): online-runner counts feed per-project health.
			scheduleInvalidation(qc, ["projects", "health"]);
			scheduleInvalidation(qc, ["pulse"]);
			// ISS-307 — a runner going offline/online moves it in/out of Attention.
			scheduleInvalidation(qc, ["attention"]);
			return;
		}
		// ISS-305, ISS-1162 — the Runners surface keys its own list under
		// ['devices','me'] and the organisation's under ['devices','org']. These ride
		// the owner's user room, so pending→approved and revoke reflect live; another
		// member's pairing rides THEIR room and reaches no client here, which is what
		// the reconnect replay is for.
		case "device.login":
		case "device.paired":
		case "device.revoked": {
			scheduleInvalidation(qc, ["devices", "me"]);
			scheduleInvalidation(qc, ["devices", "org"]);
			scheduleInvalidation(qc, ["projects", "health"]);
			scheduleInvalidation(qc, ["pulse"]);
			return;
		}
		// Workspace provisioning progress (project Runners screen live stepper).
		// Rides the project room; refresh the project's runner list each step.
		case "runner.provision": {
			if (data?.projectId) {
				scheduleInvalidation(qc, ["projects", data.projectId, "runners"]);
			}
			return;
		}
		case "runner.created":
		case "runner.status":
		case "runner.updated":
		case "runner.deleted": {
			scheduleInvalidation(qc, ["runners", data.runnerId, "activity"]);
			scheduleInvalidation(qc, ["projects", data.projectId, "runners"]);
			scheduleInvalidation(qc, ["projects", data.projectId, "active-runners"]);
			scheduleInvalidation(qc, ["projects", "health"]);
			scheduleInvalidation(qc, ["pulse"]);
			return;
		}
	}
}

/** A conversation's live frames write the socket-only keys its thread reads, then refetch it. */
function routeConversation(env: ConversationFrame, qc: QueryClient): void {
	const { event, data } = env;
	switch (event) {
		case "conversation.progress": {
			if (!data?.conversationId || typeof data.rev !== "number") return;
			const { replaced, entry } = data;
			if (replaced && entry?.id) {
				qc.setQueryData(
					["conversations", data.conversationId, "withdrawn"],
					(prev: Record<string, unknown> | undefined) => ({
						...prev,
						[entry.id]: true,
					}),
				);
			}
			const key = ["conversations", data.conversationId, "progress"];
			qc.setQueryData(key, (prev: { rev: number; entry?: { id?: string } } | undefined) => {
				if (prev && prev.entry?.id === data.entry?.id && prev.rev >= data.rev) return prev;
				return data;
			});
			return;
		}
		case "conversation.accepted": {
			const { clientToken } = data;
			if (!data?.conversationId || !clientToken) {
				if (data?.conversationId) {
					scheduleInvalidation(qc, ["conversations", data.conversationId]);
				}
				return;
			}
			qc.setQueryData(
				["conversations", data.conversationId, "accepted"],
				(prev: Record<string, unknown> | undefined) => ({
					...prev,
					[clientToken]: { messageId: data.messageId, seq: data.seq },
				}),
			);
			scheduleInvalidation(qc, ["conversations", data.conversationId]);
			return;
		}
		case "conversation.settled":
		case "conversation.message": {
			if (data?.conversationId) {
				scheduleInvalidation(qc, ["conversations", data.conversationId]);
				// a window that closed on a partial reply keeps the live entry the rest streams into
				if (event === "conversation.settled" && !("continuing" in data && data.continuing)) {
					qc.setQueryData(["conversations", data.conversationId, "progress"], null);
				}
			}
			scheduleInvalidation(qc, ["conversations", "list"]);
			return;
		}
	}
}

/** The prefixes a connection whose replay left a gap has to repair. */
const REPLAY_PREFIXES: readonly (readonly unknown[])[] = [
	["issues"],
	["projects"],
	["agent-sessions"],
	["agent-session"],
	[RUNS_STANDING_ROOT],
	["conversations"],
	["attention"],
	["pulse"],
	["devices", "me"],
	["devices", "org"],
	["integrations"],
	["integration-connections"],
	["questions"],
	["notifications"],
	["notifications-open"],
	["invitations-pending"],
	["settings", "notifications"],
	["settings", "tokens"],
];

/**
 * The broad repair, for a connection whose replay could not cover what it missed (the server
 * restarted, or the span outran what it keeps, or it did not answer): every replay prefix refetches.
 */
export function replayEverything(qc: QueryClient): void {
	for (const prefix of REPLAY_PREFIXES) invalidateThroughInFlight(qc, { queryKey: prefix });
}
