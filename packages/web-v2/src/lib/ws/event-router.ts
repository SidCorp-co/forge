"use client";

// Ported verbatim from `packages/web/src/lib/ws/event-router.ts` (ISS-288).
// The switch cases — and especially the React Query keys — are copied
// EXACTLY. web-v2 `features/*` hooks MUST reuse these same keys (e.g.
// `['projects']`) or WS-driven invalidation silently no-ops.
import type { QueryClient } from "@tanstack/react-query";
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
			qc.invalidateQueries({ queryKey: ["issues", "list"] });
			qc.invalidateQueries({ queryKey: ["issues", "search"] });
			// ISS-307 — assignment / status edits move issues in/out of the Attention
			// needs-review + awaiting-input buckets.
			qc.invalidateQueries({ queryKey: ["attention"] });
			if (data?.issueId) {
				qc.invalidateQueries({ queryKey: ["issue", data.issueId] });
				qc.invalidateQueries({ queryKey: ["activities", data.issueId] });
			}
			return;
		}
		case "issue.statusChanged": {
			qc.invalidateQueries({ queryKey: ["issues", "list"] });
			qc.invalidateQueries({ queryKey: ["issues", "search"] });
			// Projects console (ISS-290): open-issue counts / health derive from
			// issue status, so refresh the batch health rollup.
			qc.invalidateQueries({ queryKey: ["projects", "health"] });
			// ISS-307 — Attention buckets are status-driven (developed/reopen,
			// waiting/needs_info/on_hold); refresh the cross-project inbox + rail count.
			qc.invalidateQueries({ queryKey: ["attention"] });
			if (data?.issueId) {
				qc.invalidateQueries({ queryKey: ["issue", data.issueId] });
				qc.invalidateQueries({ queryKey: ["activities", data.issueId] });
			}
			return;
		}
		case "issue.pipelineHealth.changed": {
			qc.invalidateQueries({ queryKey: ["issues", "list"] });
			if (data?.issueId) {
				qc.invalidateQueries({ queryKey: ["issue", data.issueId] });
			}
			return;
		}
		case "comment.created":
		case "comment.updated":
		case "comment.deleted": {
			if (data?.issueId) {
				qc.invalidateQueries({ queryKey: ["comments", data.issueId] });
				qc.invalidateQueries({ queryKey: ["activities", data.issueId] });
			}
			return;
		}
		case "agent-session.created":
		case "agent-session.updated":
		case "agent-session.status":
		case "agent-session.deleted": {
			// ISS-291 — the sessions index (`features/sessions`) keys its queries
			// under ['agent-sessions']; without this the live list never refreshes.
			qc.invalidateQueries({ queryKey: ["agent-sessions"] });
			if (data?.sessionId) {
				qc.invalidateQueries({ queryKey: ["agent-session", data.sessionId] });
			}
			if (data?.issueId) {
				qc.invalidateQueries({ queryKey: ["activities", data.issueId] });
			}
			return;
		}
		case "agent-session.turn.appended":
		case "agent-session.turn.edited":
		case "agent-session.turn.truncated": {
			// ISS-292 — the conversation detail (`features/session`) keys turns under
			// ['agent-session', id, 'turns']; the streaming caret + live turn updates
			// ride on this invalidation. The streaming-tail `turn.appended` is
			// debounced ~100ms server-side (core `agent-sessions/broadcast.ts`).
			if (data?.sessionId) {
				qc.invalidateQueries({
					queryKey: ["agent-session", data.sessionId, "turns"],
				});
				qc.invalidateQueries({ queryKey: ["agent-session", data.sessionId] });
			}
			return;
		}
		// ISS-197 — recoveryStats refresh on the sessions panel.
		case "session.recoveryChanged": {
			qc.invalidateQueries({ queryKey: ["agent-sessions"] });
			if (data?.sessionId) {
				qc.invalidateQueries({ queryKey: ["agent-session", data.sessionId] });
			}
			return;
		}
		case "job.event": {
			if (typeof data?.seq === "number" && typeof data?.jobId === "string") {
				trackJobSeq(data.jobId, data.seq);
			}
			if (data?.jobId) {
				qc.invalidateQueries({ queryKey: ["job", data.jobId, "events"] });
				qc.invalidateQueries({ queryKey: ["job", data.jobId] });
			}
			return;
		}
		case "job.assigned":
		case "job.statusChanged":
		case "job.cancelled": {
			qc.invalidateQueries({ queryKey: ["jobs", "list"] });
			// ISS-307 — a job flipping to failed (incl. deploy) belongs in Attention's
			// failed-jobs bucket; refresh the cross-project inbox + rail count.
			qc.invalidateQueries({ queryKey: ["attention"] });
			if (data?.jobId) {
				qc.invalidateQueries({ queryKey: ["job", data.jobId] });
			}
			return;
		}
		case "pipeline_run.status_changed": {
			qc.invalidateQueries({ queryKey: ["pipeline-runs", "list"] });
			// Projects console (ISS-290): liveRuns / spend roll up from pipeline_runs.
			qc.invalidateQueries({ queryKey: ["projects", "health"] });
			if (data?.runId) {
				qc.invalidateQueries({ queryKey: ["pipeline-run", data.runId] });
			}
			// Cancel cascade flips jobs + agent_sessions too — invalidate defensively.
			if (data?.status === "cancelled") {
				qc.invalidateQueries({ queryKey: ["jobs"] });
				qc.invalidateQueries({ queryKey: ["agent-sessions"] });
			}
			return;
		}
		case "device.statusChanged": {
			qc.invalidateQueries({ queryKey: ["admin", "devices"] });
			qc.invalidateQueries({ queryKey: ["devices", "me"] });
			// Projects console (ISS-290): online-runner counts feed per-project health.
			qc.invalidateQueries({ queryKey: ["projects", "health"] });
			// ISS-307 — a runner going offline/online moves it in/out of Attention.
			qc.invalidateQueries({ queryKey: ["attention"] });
			return;
		}
		// ISS-305 — runner browser-approve device login + revoke. The Runners
		// surface (`features/runners`) keys its device list under ['devices','me'];
		// these events ride the owner's user room so pending→approved and revoke
		// reflect live without polling.
		case "device.login":
		case "device.paired":
		case "device.revoked": {
			qc.invalidateQueries({ queryKey: ["devices", "me"] });
			qc.invalidateQueries({ queryKey: ["projects", "health"] });
			return;
		}
		// Workspace provisioning progress (project Runners screen live stepper).
		// Rides the project room; refresh the project's runner list each step.
		case "runner.provision": {
			if (data?.projectId) {
				qc.invalidateQueries({
					queryKey: ["projects", data.projectId, "runners"],
				});
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
				qc.invalidateQueries({
					queryKey: ["runners", data.runnerId, "activity"],
				});
			}
			if (data?.projectId) {
				qc.invalidateQueries({
					queryKey: ["projects", data.projectId, "runners"],
				});
				qc.invalidateQueries({ queryKey: ["projects", "health"] });
			}
			return;
		}
		case "user.preferencesChanged": {
			qc.invalidateQueries({ queryKey: ["user-prefs"] });
			return;
		}
		case "notification.created":
		case "notification.read": {
			qc.invalidateQueries({ queryKey: ["notifications"] });
			qc.invalidateQueries({ queryKey: ["notifications-unread"] });
			// ISS-307 — unread @-mentions feed Attention's mentions bucket.
			qc.invalidateQueries({ queryKey: ["attention"] });
			return;
		}
		case "dependencyChanged": {
			if (data?.fromIssueId) {
				qc.invalidateQueries({
					queryKey: ["issue", data.fromIssueId, "dependencies"],
				});
				qc.invalidateQueries({ queryKey: ["issue", data.fromIssueId] });
				qc.invalidateQueries({ queryKey: ["activities", data.fromIssueId] });
			}
			if (data?.toIssueId) {
				qc.invalidateQueries({
					queryKey: ["issue", data.toIssueId, "dependencies"],
				});
				qc.invalidateQueries({ queryKey: ["issue", data.toIssueId] });
				qc.invalidateQueries({ queryKey: ["activities", data.toIssueId] });
			}
			return;
		}
		case "issue.unblockCascade":
		case "dependency.unblocked": {
			// Subscribers in `features/issue/hooks/use-unblock-cascade.ts` consume
			// these directly via `wsClient.on`; React Query has nothing to refetch.
			return;
		}
		case "pm.escalation": {
			// Web `usePmEscalations` is derived off `useNotifications`, so the
			// notifications invalidation is the only key that matters here.
			qc.invalidateQueries({ queryKey: ["notifications"] });
			qc.invalidateQueries({ queryKey: ["notifications-unread"] });
			return;
		}
		case "integration.changed": {
			// ISS-401/C — a binding mutation (create/update/delete/rotate-secret/
			// confirm-prod-deploy) broadcasts this to the project room. Refresh the
			// project-facing bindings list + composed status, and the owner-scoped
			// connections list (keyed without a projectId). Connection-only mutations
			// do not emit (no owner WS room) — they self-invalidate client-side.
			if (data?.projectId) {
				qc.invalidateQueries({
					queryKey: ["integrations", "list", data.projectId],
				});
				qc.invalidateQueries({
					queryKey: ["integrations", "status", data.projectId],
				});
				qc.invalidateQueries({
					queryKey: ["integrations", "mcp-preview", data.projectId],
				});
			}
			qc.invalidateQueries({ queryKey: ["integration-connections"] });
			return;
		}
		case "pat.created":
		case "pat.revoked":
		case "pat.used": {
			// ISS-160 — keep the /settings/tokens list in sync. The `pat.used`
			// event is throttled to 1/min/token in the dispatcher; we still
			// invalidate the list so last-used relative timestamps refresh.
			qc.invalidateQueries({ queryKey: ["tokens"] });
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
 * On reconnect, replay dropped events for any job whose detail page is
 * still mounted. Project-room events don't have a seq; we just invalidate
 * the high-level caches so React Query refetches anything visible.
 */
export function replayOnReconnect(qc: QueryClient): void {
	qc.invalidateQueries({ queryKey: ["issues"] });
	qc.invalidateQueries({ queryKey: ["jobs"] });
	qc.invalidateQueries({ queryKey: ["projects"] });
	// ISS-291 — refresh the sessions index after a dropped connection.
	qc.invalidateQueries({ queryKey: ["agent-sessions"] });
	// ISS-292 — refresh any open conversation detail (`['agent-session', id, …]`)
	// so a session viewed across a reconnect re-pulls its turns + status.
	qc.invalidateQueries({ queryKey: ["agent-session"] });
	// ISS-307 — refresh the cross-project Attention inbox + rail count after a
	// dropped connection (its buckets ride issue/job/notification events above).
	qc.invalidateQueries({ queryKey: ["attention"] });
	qc.invalidateQueries({ queryKey: ["devices", "me"] });
	// ISS-314 — refresh the cross-project Activity feed (`features/activity`,
	// keyed ['chat-logs']) after a dropped connection. chat_logs has no per-row
	// WS broadcast yet, so reconnect replay (+ window-focus refetch + Refresh) is
	// its freshness signal until a `chat-log.created` event lands in core.
	qc.invalidateQueries({ queryKey: ["chat-logs"] });
	// ISS-401/C — refresh integration bindings/status (per-project) + the owner-
	// scoped connections list after a dropped connection. Connection mutations
	// have no WS broadcast, so reconnect replay is their cross-client freshness.
	qc.invalidateQueries({ queryKey: ["integrations"] });
	qc.invalidateQueries({ queryKey: ["integration-connections"] });
}
