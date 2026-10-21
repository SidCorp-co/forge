"use client";

import type { QueryClient } from "@tanstack/react-query";
import { invalidateThroughInFlight } from "./invalidate-through-inflight";
import { moveSessionInLiveReads } from "@/features/pipeline/live-read";
import { scheduleInvalidation } from "./invalidation-coalescer";
import { trackJobSeq } from "./seq-tracker";

/** The issue page's run journal, `runJournalKey` in features/issues/detail-hooks.ts. */
const RUN_JOURNAL = "run-journal";
/** The Agents runs tab, `runSessionsKey` in features/agents/hooks.ts. */
const RUN_SESSIONS = "run-sessions";
const SESSIONS_AND_HOLDS = "sessions-and-holds";

/** The status this tab last heard for each session, so a check-in that moves none is told apart. */
const lastStatus = new Map<string, string>();
const LAST_STATUS_CAP = 1000;

function seeStatus(sessionId: string, status: string): void {
	lastStatus.delete(sessionId);
	lastStatus.set(sessionId, status);
	if (lastStatus.size > LAST_STATUS_CAP) {
		const oldest = lastStatus.keys().next().value;
		if (oldest !== undefined) lastStatus.delete(oldest);
	}
}

// biome-ignore lint/suspicious/noExplicitAny: heterogeneous payloads
function statusUnmoved(data: any): data is { sessionId: string; status: string; started?: boolean } {
	return (
		typeof data?.sessionId === "string" &&
		typeof data?.status === "string" &&
		lastStatus.get(data.sessionId) === data.status
	);
}

/** A session's check-in that leaves its status alone moves no count, no issue page and no rollup:
 *  only the session's own page and the lists that show the session re-read (ISS-1228). */
function rereadWhatShowsSession(qc: QueryClient, sessionId: string): void {
	// A check-in changes no refusal's answer, so a read Forge refused for good is passed by (ISS-1228 r25).
	const spareRefused = { spareRefused: true };
	scheduleInvalidation(qc, ["agent-session", sessionId], spareRefused);
	scheduleInvalidation(qc, ["agent-sessions"], spareRefused);
	scheduleInvalidation(qc, [SESSIONS_AND_HOLDS], spareRefused);
	scheduleInvalidation(qc, [RUN_SESSIONS], spareRefused);
}

/** Every read that says a run's word: its row on the runs tab, its open drawer and the issue page's Runs. */
function rereadRunReadings(qc: QueryClient): void {
	scheduleInvalidation(qc, ["pipeline-runs", "list"]);
	scheduleInvalidation(qc, ["pipeline-run"]);
	scheduleInvalidation(qc, [RUN_JOURNAL]);
}

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
			scheduleInvalidation(qc, [SESSIONS_AND_HOLDS]);
			scheduleInvalidation(qc, ["attention"]);
			scheduleInvalidation(qc, ["pulse"]);
			if (data?.issueId) {
				scheduleInvalidation(qc, ["issue", data.issueId]);
				scheduleInvalidation(qc, [RUN_JOURNAL, data.issueId]);
				scheduleInvalidation(qc, ["activities", data.issueId]);
			}
			return;
		}
		case "issue.statusChanged": {
			scheduleInvalidation(qc, ["issues", "list"]);
			scheduleInvalidation(qc, ["issues", "search"]);
			scheduleInvalidation(qc, [SESSIONS_AND_HOLDS]);
			scheduleInvalidation(qc, ["projects", "health"]);
			scheduleInvalidation(qc, ["pulse"]);
			scheduleInvalidation(qc, ["attention"]);
			if (data?.issueId) {
				scheduleInvalidation(qc, ["issue", data.issueId]);
				scheduleInvalidation(qc, [RUN_JOURNAL, data.issueId]);
				scheduleInvalidation(qc, ["activities", data.issueId]);
				scheduleInvalidation(qc, ["questions", data.issueId]);
			}
			return;
		}
		case "issue.pipelineHealth.changed": {
			scheduleInvalidation(qc, ["issues", "list"]);
			if (data?.issueId) {
				scheduleInvalidation(qc, ["issue", data.issueId]);
				scheduleInvalidation(qc, [RUN_JOURNAL, data.issueId]);
			}
			if (data?.projectId) {
				scheduleInvalidation(qc, ["projects", data.projectId, "active-runners"]);
			}
			return;
		}
		// An answered question changes what every open page of its issue reads — "Needs an answer", the
		// Answer action, the run's word, the park — for its answerer and every other reader (ISS-1228).
		case "question.answered": {
			scheduleInvalidation(qc, ["attention"]);
			scheduleInvalidation(qc, ["pulse"]);
			rereadRunReadings(qc);
			if (data?.issueId) {
				scheduleInvalidation(qc, ["questions", data.issueId]);
				scheduleInvalidation(qc, ["issue", data.issueId]);
				scheduleInvalidation(qc, ["comments", data.issueId]);
				scheduleInvalidation(qc, ["activities", data.issueId]);
			}
			if (data?.projectId) scheduleInvalidation(qc, ["questions", "project", data.projectId]);
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
			// The live read drops a stopped session as its event arrives, before the re-read lands (ISS-1228).
			if (typeof data?.sessionId === "string" && typeof data?.status === "string") {
				moveSessionInLiveReads(qc, data.sessionId, data.status);
			}
			if (event === "agent-session.updated" && statusUnmoved(data)) {
				rereadWhatShowsSession(qc, data.sessionId);
				if (data.started === true) rereadRunReadings(qc);
				return;
			}
			if (typeof data?.sessionId === "string" && typeof data?.status === "string") {
				seeStatus(data.sessionId, data.status);
			}
			scheduleInvalidation(qc, ["agent-sessions"]);
			scheduleInvalidation(qc, [SESSIONS_AND_HOLDS]);
			// A session's events name no issue, so every open issue page and runs tab re-reads (ISS-1228).
			rereadRunReadings(qc);
			scheduleInvalidation(qc, [RUN_SESSIONS]);
			// The rail and the projects console count live sessions off the health rollup.
			scheduleInvalidation(qc, ["projects", "health"]);
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
		case "job.retried":
		case "job.cancelled": {
			scheduleInvalidation(qc, ["jobs", "list"]);
			rereadRunReadings(qc);
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
			scheduleInvalidation(qc, data?.issueId ? [RUN_JOURNAL, data.issueId] : [RUN_JOURNAL]);
			// Projects console (ISS-290): spend rolls up from pipeline_runs.
			scheduleInvalidation(qc, ["projects", "health"]);
			scheduleInvalidation(qc, ["pulse"]);
			if (data?.runId) {
				scheduleInvalidation(qc, ["pipeline-run", data.runId]);
			}
			// Cancel cascade flips jobs + agent_sessions too — invalidate defensively.
			if (data?.status === "cancelled") {
				scheduleInvalidation(qc, ["jobs"]);
				scheduleInvalidation(qc, ["agent-sessions"]);
				scheduleInvalidation(qc, [RUN_SESSIONS]);
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
			scheduleInvalidation(qc, ["devices", "org"]);
			// Projects console (ISS-290): online-runner counts feed per-project health.
			scheduleInvalidation(qc, ["projects", "health"]);
			scheduleInvalidation(qc, ["pulse"]);
			// ISS-307 — a runner going offline/online moves it in/out of Attention.
			scheduleInvalidation(qc, ["attention"]);
			return;
		}
		// ISS-305, ISS-1162 — the Runners surface keys its own list under
		// ['devices','me'] and the organization's under ['devices','org']. These ride
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
		// Every session read states its box's state, so the strip and the rows refresh together (ISS-1228).
		case "device.status": {
			if (!data?.projectId) return;
			scheduleInvalidation(qc, ["projects", data.projectId, "runners"]);
			scheduleInvalidation(qc, ["projects", data.projectId, "active-runners"]);
			scheduleInvalidation(qc, ["agent-sessions"]);
			scheduleInvalidation(qc, ["agent-session"]);
			scheduleInvalidation(qc, [SESSIONS_AND_HOLDS]);
			scheduleInvalidation(qc, [RUN_SESSIONS]);
			rereadRunReadings(qc);
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
	[RUN_JOURNAL],
	["pipeline-runs"],
	["pipeline-run"],
	[RUN_SESSIONS],
	[SESSIONS_AND_HOLDS],
	["jobs"],
	["projects"],
	["agent-sessions"],
	["agent-session"],
	["conversations"],
	["attention"],
	["pulse"],
	["devices", "me"],
	["devices", "org"],
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
