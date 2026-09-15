"use client";

// cm:guard a `features/*` hook must key its query under one of the prefixes invalidated below (e.g. ['projects']) — pick any other and the live update silently no-ops, with nothing red anywhere to say the screen stopped refreshing
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
			// cm:why an assignment or status edit moves an issue between the needs-review and awaiting-input buckets, which are derived on read and cached nowhere server-side — so nothing else tells the inbox it is stale (ISS-307)
			scheduleInvalidation(qc, ["attention"]);
			scheduleInvalidation(qc, ["pulse"]);
			// cm:why ISS-665 — the Overview "Recent changes" panel is ordered by `issues.updatedAt`, which every one of these three events bumps; without this it keeps the previous ordering until something unrelated refetches
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
			// cm:why the console's open-issue counts and health are derived from issue status, so a transition is the only event that dates the batch rollup (ISS-290)
			scheduleInvalidation(qc, ["projects", "health"]);
			scheduleInvalidation(qc, ["pulse"]);
			// cm:why every attention bucket is derived from `issues.status` on read (packages/core/src/me/attention-buckets.ts) and none of them is cached server-side, so a status event is the only signal that the cross-project inbox and its rail badge are stale — nothing else fires for an issue in a project this client is not looking at.
			scheduleInvalidation(qc, ["attention"]);
			// cm:why the Overview "Recent changes" panel is ordered by `issues.updatedAt`, and a status transition is the commonest writer of it — without this the panel keeps the previous ordering until something unrelated refetches (ISS-665).
			scheduleInvalidation(qc, ["recent-changes"]);
			if (data?.issueId) {
				scheduleInvalidation(qc, ["issue", data.issueId]);
				scheduleInvalidation(qc, ["activities", data.issueId]);
				// cm:why a run that parks to ask writes the question and the issue's park status together, and core publishes nothing else a browser subscribes to — this is the only event that reaches a screen already open on an issue whose decision has just appeared (ISS-980).
				scheduleInvalidation(qc, ["questions", data.issueId]);
			}
			return;
		}
		case "issue.pipelineHealth.changed": {
			scheduleInvalidation(qc, ["issues", "list"]);
			if (data?.issueId) {
				scheduleInvalidation(qc, ["issue", data.issueId]);
			}
			// Fires on every job completion/failure + dispatch tick and carries
			// projectId — the reliable hook for the active-runner snapshot, since
			// a mid-pipeline stage flip (code done → test queued) leaves the run
			// `status='running'` so `pipeline_run.status_changed` never fires, and
			// `job.completed`/`job.failed` carry only jobId (no projectId to key on).
			if (data?.projectId) {
				scheduleInvalidation(qc, ["projects", data.projectId, "active-runners"]);
			}
			return;
		}
		case "comment.created":
		case "comment.updated":
		case "comment.deleted": {
			// cm:why a human comment is the receipt that clears an unseen agent-filed draft (ISS-881), and an @mention arrives as a comment too; without this the row the user just acted on stays on screen until something unrelated refetches.
			scheduleInvalidation(qc, ["attention"]);
			scheduleInvalidation(qc, ["pulse"]);
			if (data?.issueId) {
				scheduleInvalidation(qc, ["comments", data.issueId]);
				scheduleInvalidation(qc, ["activities", data.issueId]);
			}
			return;
		}
		// cm:edge contract -> packages/core/src/assistant/conversation-adapter.ts — the `deliver` half of the Forge UI's conversation transport publishes this into each person's own user room; the name and the payload are settled there, and a rename on either side leaves the open thread correct only after a reload. `conversation.settled` is the second half of the pair and arrives after the row is durable, which is why both invalidate rather than either one appending (ISS-1004 step 5).
		case "conversation.settled":
		case "conversation.message": {
			if (data?.conversationId) {
				scheduleInvalidation(qc, ["conversations", data.conversationId]);
			}
			scheduleInvalidation(qc, ["conversations", "list"]);
			return;
		}
		case "agent-session.created":
		case "agent-session.updated":
		case "agent-session.status":
		case "agent-session.deleted": {
			// cm:why the sessions index keys its queries under ['agent-sessions'], and nothing else fires for a standalone session, so without this the live list never refreshes (ISS-291)
			scheduleInvalidation(qc, ["agent-sessions"]);
			// cm:why `quality.sessionFailures` counts failed sessions by reason, so a session reaching `failed` is the only event that dates that figure — the issue and job events elsewhere in this switch never fire for a standalone interactive session (ISS-988)
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
			// cm:guard these three are the RUN detail's, not a conversation's: since ISS-1004 step 5 `features/session` is the screen whose subject is a session on a runner, and the chat surface reads `conversation.message` / `conversation.settled` above instead. The streaming-tail `turn.appended` is debounced ~100ms server-side (core `agent-sessions/broadcast.ts`), so a caret that stops moving is that debounce before it is this key (ISS-292).
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
		// cm:edge contract -> packages/core/src/jobs/resume-job.ts — a resumed job leaves `held` for `queued`, so both the list and the job detail are stale; without this case the operator presses resume and the row keeps reading "held" until something unrelated invalidates it
		case "job.resumed":
		case "job.cancelled": {
			scheduleInvalidation(qc, ["jobs", "list"]);
			// cm:edge contract -> packages/web-v2/src/features/operator/hooks.ts — A2 (stuck jobs) and the in-flight KPI both count `jobs` rows, so a reap that clears the alert must clear it on screen; without this the operator presses the button and the row it just cancelled is still listed
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
			// cm:edge contract -> packages/web-v2/src/features/operator/hooks.ts — all four Operator Ops Console panels roll up from `pipeline_runs` and are keyed under this prefix; a key that does not start ["admin","ops"] leaves the console serving stale cross-tenant numbers with nothing to say it (ISS-653)
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
		// A runner's status flipped (heartbeat online / stale offline / operator
		// patch / rate-or-usage-limit stamp+clear). Refresh that runner's
		// activity feed (status-history timeline) if open — keyed by runnerId.
		// When the payload carries a projectId (limit stamp/clear, heartbeat),
		// also refresh the project's runner list + health so the dashboard
		// runners card and Runners screen reflect the limit badge/countdown live.
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
			scheduleInvalidation(qc, ["notifications-unread"]);
			// ISS-307 — unread @-mentions feed Attention's mentions bucket.
			scheduleInvalidation(qc, ["attention"]);
			scheduleInvalidation(qc, ["pulse"]);
			// ISS-597 — an invitation_received notification means a new pending
			// invite; refresh the pending list so the actionable item appears live.
			scheduleInvalidation(qc, ["invitations-pending"]);
			return;
		}
		case "dependencyChanged": {
			// cm:why ISS-1017 — the issues list renders its badges from the search response (`withDependencies=1`), so the per-issue keys below no longer reach it and the chips would outlive a retracted edge until something unrelated refetched the list
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
			// cm:edge protocol -> packages/web-v2/src/features/issues/use-unblock-cascade.ts — consumed there via wsClient.on, which is why this branch refetches nothing; delete that hook and both events go silent with nothing here going red
			return;
		}
		case "pm.escalation": {
			// Web `usePmEscalations` is derived off `useNotifications`, so the
			// notifications invalidation is the only key that matters here.
			scheduleInvalidation(qc, ["notifications"]);
			scheduleInvalidation(qc, ["notifications-unread"]);
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
	// cm:why ISS-291 — the sessions index refreshes after a dropped connection here.
	["agent-sessions"],
	// cm:why a run thread open across a reconnect re-pulls its turns and its status here, because every live update it has is an invalidation it may have missed (ISS-292)
	["agent-session"],
	// cm:guard an open conversation is replayed here or not at all: its reply arrives as ONE `conversation.message` frame, so a dropped frame leaves the answer invisible until something else refetches (ISS-1004)
	["conversations"],
	// cm:why ISS-307 — the cross-project Attention inbox and its rail count ride issue/job/notification events, so a dropped connection is repaired here.
	["attention"],
	["pulse"],
	["devices", "me"],
	// cm:why `chat_logs` has no per-row WS broadcast in core, so this plus window-focus and the Refresh button is the whole of the cross-project Activity feed's freshness until a `chat-log.created` event lands (ISS-314).
	["chat-logs"],
	// cm:why ISS-401/C — integration bindings, status and the owner-scoped connections list have no broadcast for connection-only mutations, so reconnect replay is their cross-client freshness.
	["integrations"],
	["integration-connections"],
	// cm:guard the ONE recovery an empty decision panel has. `features/questions` polls only once an issue already carries a question — `agent_questions` has no index on `issue_id` — so a screen open across a dropped connection learns of its first question here or not until the next navigation (ISS-980).
	["questions"],
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
	for (const prefix of REPLAY_PREFIXES) qc.invalidateQueries({ queryKey: prefix });
}

/**
 * The FIRST open of a connection is not a reconnect, and replaying it as one is
 * a second whole round of the page's queries a few hundred milliseconds after
 * the first.
 *
 * What is owed is narrower. A query that already holds data whose `dataUpdatedAt`
 * is at or before `openedAt` had its answer on screen while the socket was not
 * yet delivering — that is a real gap and it is replayed. A query whose only data
 * arrived after the open cannot have missed anything: the socket was already
 * delivering by then. A query still fetching its first result is left to
 * `invalidateThroughInFlight`, which picks it up when it settles.
 *
 * `questions` is replayed whatever its state, because its guard above says this
 * replay is the one recovery an empty decision panel has.
 *
 * This is ONE call with ONE predicate rather than two passes, so a `questions`
 * query holding pre-open data is refetched once and not twice.
 */
// cm:guard blanket suppression behind a `hasConnected` flag is refused, and this is the shape that replaces it: REST can complete before the socket connects, and a change in that gap reaches the screen through the first-open replay or through nothing (ISS-1019).
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
