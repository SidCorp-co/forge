"use client";

import type { QueryClient } from "@tanstack/react-query";
import { invalidateThroughInFlight } from "./invalidate-through-inflight";
import { scheduleInvalidation } from "./invalidation-coalescer";
import { trackJobSeq } from "./seq-tracker";

interface EventEnvelope {
	event: string;
	// biome-ignore lint/suspicious/noExplicitAny: heterogeneous payloads
	data: any;
	timestamp: string;
}

/**
 * Dispatch a WS event to React Query cache invalidations. Keys must match
 * the ones declared in features/issue + features/job + features/project
 * hook modules — renaming one side without the other silently breaks
 * realtime updates.
 */
export function routeEvent(env: EventEnvelope, qc: QueryClient): void {
	const { event, data } = env;
	switch (event) {
		case "issue.created":
		case "issue.updated":
		case "issue.deleted": {
			scheduleInvalidation(qc, ["issues", "list"]);
			scheduleInvalidation(qc, ["issues", "search"]);
			scheduleInvalidation(qc, ["attention"]);
			scheduleInvalidation(qc, ["pulse"]);
			scheduleInvalidation(qc, ["recent-changes"]);
			if (data?.issueId) {
				scheduleInvalidation(qc, ["issue", data.issueId]);
				scheduleInvalidation(qc, ["activities", data.issueId]);
			}
			return;
		}
		case "issue.statusChanged": {
			scheduleInvalidation(qc, ["issues", "list"]);
			scheduleInvalidation(qc, ["issues", "search"]);
			scheduleInvalidation(qc, ["projects", "health"]);
			scheduleInvalidation(qc, ["pulse"]);
			scheduleInvalidation(qc, ["attention"]);
			scheduleInvalidation(qc, ["recent-changes"]);
			if (data?.issueId) {
				scheduleInvalidation(qc, ["issue", data.issueId]);
				scheduleInvalidation(qc, ["activities", data.issueId]);
				scheduleInvalidation(qc, ["questions", data.issueId]);
			}
			return;
		}
		case "issue.pipelineHealth.changed": {
			scheduleInvalidation(qc, ["issues", "list"]);
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
		case "conversation.progress": {
			if (!data?.conversationId || typeof data.rev !== "number") return;
			if (data.replaced && data.entry?.id) {
				qc.setQueryData(
					["conversations", data.conversationId, "withdrawn"],
					(prev: Record<string, unknown> | undefined) => ({
						...prev,
						[data.entry.id]: data.replaced.draft,
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
			if (!data?.conversationId || !data?.clientToken) {
				if (data?.conversationId) {
					scheduleInvalidation(qc, ["conversations", data.conversationId]);
				}
				return;
			}
			qc.setQueryData(
				["conversations", data.conversationId, "accepted"],
				(prev: Record<string, unknown> | undefined) => ({
					...prev,
					[data.clientToken]: { messageId: data.messageId, seq: data.seq },
				}),
			);
			scheduleInvalidation(qc, ["conversations", data.conversationId]);
			return;
		}
		case "conversation.settled":
		case "conversation.message": {
			if (data?.conversationId) {
				scheduleInvalidation(qc, ["conversations", data.conversationId]);
				if (event === "conversation.settled") {
					qc.setQueryData(["conversations", data.conversationId, "progress"], null);
				}
			}
			scheduleInvalidation(qc, ["conversations", "list"]);
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
		// ISS-197 — recoveryStats refresh on the sessions panel.
		case "session.recoveryChanged": {
			scheduleInvalidation(qc, ["agent-sessions"]);
			if (data?.sessionId) {
				scheduleInvalidation(qc, ["agent-session", data.sessionId]);
			}
			return;
		}
		case "job.event": {
			if (typeof data?.seq === "number" && typeof data?.jobId === "string") {
				trackJobSeq(data.jobId, data.seq);
			}
			if (data?.jobId) {
				scheduleInvalidation(qc, ["job", data.jobId, "events"]);
				scheduleInvalidation(qc, ["job", data.jobId]);
			}
			return;
		}
		case "job.assigned":
		case "job.completed":
		case "job.failed":
		case "job.resumed":
		case "job.cancelled": {
			scheduleInvalidation(qc, ["jobs", "list"]);
			scheduleInvalidation(qc, ["admin", "ops"]);
			// ISS-307 — a job flipping to failed (incl. deploy) belongs in Attention's
			// failed-jobs bucket; refresh the cross-project inbox + rail count.
			scheduleInvalidation(qc, ["attention"]);
			scheduleInvalidation(qc, ["pulse"]);
			if (data?.jobId) {
				scheduleInvalidation(qc, ["job", data.jobId]);
			}
			// NOTE: the active-runner snapshot is refreshed via
			// `issue.pipelineHealth.changed` (which carries projectId and fires on
			// the same completions). These job.* payloads carry only jobId, and
			// `job.assigned` rides the device room — not the project room — so
			// there's nothing reliable to key an active-runners invalidation on here.
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
			// Cancel cascade flips jobs + agent_sessions too — invalidate defensively.
			if (data?.status === "cancelled") {
				scheduleInvalidation(qc, ["jobs"]);
				scheduleInvalidation(qc, ["agent-sessions"]);
			}
			// A run reaching a terminal status frees its runner — refresh the
			// active-runner snapshot so the busy → idle flip reflects live.
			if (data?.projectId) {
				scheduleInvalidation(qc, ["projects", data.projectId, "active-runners"]);
			}
			return;
		}
		case "device.statusChanged": {
			scheduleInvalidation(qc, ["admin", "devices"]);
			scheduleInvalidation(qc, ["devices", "me"]);
			// Projects console (ISS-290): online-runner counts feed per-project health.
			scheduleInvalidation(qc, ["projects", "health"]);
			scheduleInvalidation(qc, ["pulse"]);
			// ISS-307 — a runner going offline/online moves it in/out of Attention.
			scheduleInvalidation(qc, ["attention"]);
			return;
		}
		// ISS-305 — runner browser-approve device login + revoke. The Runners
		// surface (`features/runners`) keys its device list under ['devices','me'];
		// these events ride the owner's user room so pending→approved and revoke
		// reflect live without polling.
		case "device.login":
		case "device.paired":
		case "device.revoked": {
			scheduleInvalidation(qc, ["devices", "me"]);
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
		case "runner.status":
		case "runner.updated": {
			if (data?.runnerId) {
				scheduleInvalidation(qc, ["runners", data.runnerId, "activity"]);
			}
			if (data?.projectId) {
				scheduleInvalidation(qc, ["projects", data.projectId, "runners"]);
				scheduleInvalidation(qc, ["projects", data.projectId, "active-runners"]);
				scheduleInvalidation(qc, ["projects", "health"]);
				scheduleInvalidation(qc, ["pulse"]);
			}
			return;
		}
		case "user.preferencesChanged": {
			scheduleInvalidation(qc, ["user-prefs"]);
			return;
		}
		case "notification.created":
		case "notification.read": {
			scheduleInvalidation(qc, ["notifications"]);
			scheduleInvalidation(qc, ["notifications-open"]);
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
			if (data?.fromIssueId) {
				scheduleInvalidation(qc, ["issue", data.fromIssueId, "dependencies"]);
				scheduleInvalidation(qc, ["issue", data.fromIssueId]);
				scheduleInvalidation(qc, ["activities", data.fromIssueId]);
			}
			if (data?.toIssueId) {
				scheduleInvalidation(qc, ["issue", data.toIssueId, "dependencies"]);
				scheduleInvalidation(qc, ["issue", data.toIssueId]);
				scheduleInvalidation(qc, ["activities", data.toIssueId]);
			}
			return;
		}
		case "issue.unblockCascade":
		case "dependency.unblocked": {
			return;
		}
		case "pm.escalation": {
			// Web `usePmEscalations` is derived off `useNotifications`, so the
			// notifications invalidation is the only key that matters here.
			scheduleInvalidation(qc, ["notifications"]);
			scheduleInvalidation(qc, ["notifications-open"]);
			return;
		}
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
			// ISS-160 — keep the /settings/tokens list in sync. The `pat.used`
			// event is throttled to 1/min/token in the dispatcher; we still
			// invalidate the list so last-used relative timestamps refresh.
			scheduleInvalidation(qc, ["tokens"]);
			return;
		}
		default: {
			// Unknown event: no-op. Log once per event kind in dev to surface
			// missing wiring on the client side.
			if (process.env.NODE_ENV !== "production") {
				console.debug("[ws] unhandled event", event, data);
			}
		}
	}
}

/**
 * The prefixes a dropped or freshly-opened connection has to repair. One list,
 * read by both replays, so the two cannot drift apart.
 */
const REPLAY_PREFIXES: readonly (readonly unknown[])[] = [
	["issues"],
	["jobs"],
	["projects"],
	["agent-sessions"],
	["agent-session"],
	["conversations"],
	["attention"],
	["pulse"],
	["devices", "me"],
	["chat-logs"],
	["integrations"],
	["integration-connections"],
	["questions"],
	["notifications"],
	["notifications-open"],
	["invitations-pending"],
];

const QUESTIONS_PREFIX = "questions";

function underAReplayPrefix(queryKey: readonly unknown[]): boolean {
	return REPLAY_PREFIXES.some((prefix) =>
		prefix.every((segment, i) => Object.is(queryKey[i], segment)),
	);
}

/**
 * On reconnect, replay dropped events for any job whose detail page is
 * still mounted. Project-room events don't have a seq; we just invalidate
 * the high-level caches so React Query refetches anything visible.
 */
export function replayOnReconnect(qc: QueryClient): void {
	for (const prefix of REPLAY_PREFIXES) invalidateThroughInFlight(qc, { queryKey: prefix });
}

export function replayOnFirstOpen(qc: QueryClient, openedAt: number): void {
	invalidateThroughInFlight(qc, {
		predicate: (query) => {
			const key = query.queryKey as readonly unknown[];
			if (key[0] === QUESTIONS_PREFIX) return true;
			if (!underAReplayPrefix(key)) return false;
			const { dataUpdatedAt } = query.state;
			return dataUpdatedAt > 0 && dataUpdatedAt <= openedAt;
		},
	});
}
