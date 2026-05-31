'use client';

// Ported verbatim from `packages/web/src/lib/ws/event-router.ts` (ISS-288).
// The switch cases — and especially the React Query keys — are copied
// EXACTLY. web-v2 `features/*` hooks MUST reuse these same keys (e.g.
// `['projects']`) or WS-driven invalidation silently no-ops.
import type { QueryClient } from '@tanstack/react-query';
import { trackJobSeq } from './seq-tracker';

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
    case 'issue.created':
    case 'issue.updated':
    case 'issue.deleted': {
      qc.invalidateQueries({ queryKey: ['issues', 'list'] });
      qc.invalidateQueries({ queryKey: ['issues', 'search'] });
      // ISS-296 — the cross-project activity feed (`features/activity`) keys
      // under ['activity']; issue lifecycle events surface in it.
      qc.invalidateQueries({ queryKey: ['activity'] });
      if (data?.issueId) {
        qc.invalidateQueries({ queryKey: ['issue', data.issueId] });
        qc.invalidateQueries({ queryKey: ['activities', data.issueId] });
      }
      return;
    }
    case 'issue.statusChanged': {
      qc.invalidateQueries({ queryKey: ['issues', 'list'] });
      qc.invalidateQueries({ queryKey: ['issues', 'search'] });
      // Projects console (ISS-290): open-issue counts / health derive from
      // issue status, so refresh the batch health rollup.
      qc.invalidateQueries({ queryKey: ['projects', 'health'] });
      // ISS-296 — status changes are the primary activity-feed events.
      qc.invalidateQueries({ queryKey: ['activity'] });
      if (data?.issueId) {
        qc.invalidateQueries({ queryKey: ['issue', data.issueId] });
        qc.invalidateQueries({ queryKey: ['activities', data.issueId] });
      }
      return;
    }
    case 'issue.pipelineHealth.changed': {
      qc.invalidateQueries({ queryKey: ['issues', 'list'] });
      if (data?.issueId) {
        qc.invalidateQueries({ queryKey: ['issue', data.issueId] });
      }
      return;
    }
    case 'comment.created':
    case 'comment.updated':
    case 'comment.deleted': {
      // ISS-296 — comments appear in the cross-project activity feed.
      qc.invalidateQueries({ queryKey: ['activity'] });
      if (data?.issueId) {
        qc.invalidateQueries({ queryKey: ['comments', data.issueId] });
        qc.invalidateQueries({ queryKey: ['activities', data.issueId] });
      }
      return;
    }
    case 'agent-session.created':
    case 'agent-session.updated':
    case 'agent-session.status':
    case 'agent-session.deleted': {
      // ISS-291 — the sessions index (`features/sessions`) keys its queries
      // under ['agent-sessions']; without this the live list never refreshes.
      qc.invalidateQueries({ queryKey: ['agent-sessions'] });
      // ISS-296 — agent handoffs are the headline of the activity feed.
      qc.invalidateQueries({ queryKey: ['activity'] });
      if (data?.sessionId) {
        qc.invalidateQueries({ queryKey: ['agent-session', data.sessionId] });
      }
      if (data?.issueId) {
        qc.invalidateQueries({ queryKey: ['activities', data.issueId] });
      }
      return;
    }
    case 'agent-session.turn.appended':
    case 'agent-session.turn.edited':
    case 'agent-session.turn.truncated': {
      // ISS-292 — the conversation detail (`features/session`) keys turns under
      // ['agent-session', id, 'turns']; the streaming caret + live turn updates
      // ride on this invalidation. The streaming-tail `turn.appended` is
      // debounced ~100ms server-side (core `agent-sessions/broadcast.ts`).
      if (data?.sessionId) {
        qc.invalidateQueries({ queryKey: ['agent-session', data.sessionId, 'turns'] });
        qc.invalidateQueries({ queryKey: ['agent-session', data.sessionId] });
      }
      return;
    }
    // ISS-197 — recoveryStats refresh on the sessions panel.
    case 'session.recoveryChanged': {
      qc.invalidateQueries({ queryKey: ['agent-sessions'] });
      if (data?.sessionId) {
        qc.invalidateQueries({ queryKey: ['agent-session', data.sessionId] });
      }
      return;
    }
    case 'job.event': {
      if (typeof data?.seq === 'number' && typeof data?.jobId === 'string') {
        trackJobSeq(data.jobId, data.seq);
      }
      if (data?.jobId) {
        qc.invalidateQueries({ queryKey: ['job', data.jobId, 'events'] });
        qc.invalidateQueries({ queryKey: ['job', data.jobId] });
      }
      return;
    }
    case 'job.assigned':
    case 'job.statusChanged':
    case 'job.cancelled': {
      qc.invalidateQueries({ queryKey: ['jobs', 'list'] });
      if (data?.jobId) {
        qc.invalidateQueries({ queryKey: ['job', data.jobId] });
      }
      return;
    }
    case 'pipeline_run.status_changed': {
      qc.invalidateQueries({ queryKey: ['pipeline-runs', 'list'] });
      // Projects console (ISS-290): liveRuns / spend roll up from pipeline_runs.
      qc.invalidateQueries({ queryKey: ['projects', 'health'] });
      if (data?.runId) {
        qc.invalidateQueries({ queryKey: ['pipeline-run', data.runId] });
      }
      // Cancel cascade flips jobs + agent_sessions too — invalidate defensively.
      if (data?.status === 'cancelled') {
        qc.invalidateQueries({ queryKey: ['jobs'] });
        qc.invalidateQueries({ queryKey: ['agent-sessions'] });
      }
      return;
    }
    // ISS-296 — core emits `device.status` (the prior `device.statusChanged`
    // key was drift); handle both. The Runners console (`features/runners`)
    // keys devices under ['devices'] and runners under ['runners', projectId].
    case 'device.status':
    case 'device.statusChanged': {
      qc.invalidateQueries({ queryKey: ['admin', 'devices'] });
      qc.invalidateQueries({ queryKey: ['devices'] });
      // Projects console (ISS-290): online-runner counts feed per-project health.
      qc.invalidateQueries({ queryKey: ['projects', 'health'] });
      return;
    }
    // ISS-296 — runner lifecycle events refresh the per-project runner list
    // and any device card grouping those runners.
    case 'runner.created':
    case 'runner.updated':
    case 'runner.deleted': {
      if (data?.projectId) {
        qc.invalidateQueries({ queryKey: ['runners', data.projectId] });
      } else {
        qc.invalidateQueries({ queryKey: ['runners'] });
      }
      qc.invalidateQueries({ queryKey: ['devices'] });
      qc.invalidateQueries({ queryKey: ['projects', 'health'] });
      return;
    }
    // ISS-305 — runner browser-approve device login + revoke. These ride the
    // owner's user room so pending→approved and revoke reflect live without
    // polling. The unified Runners console keys devices under the broad
    // ['devices'] prefix (⊇ ['devices','mine']), so invalidate that.
    case 'device.login':
    case 'device.paired':
    case 'device.revoked': {
      qc.invalidateQueries({ queryKey: ['devices'] });
      qc.invalidateQueries({ queryKey: ['projects', 'health'] });
      return;
    }
    case 'user.preferencesChanged': {
      qc.invalidateQueries({ queryKey: ['user-prefs'] });
      return;
    }
    case 'notification.created':
    case 'notification.read': {
      qc.invalidateQueries({ queryKey: ['notifications'] });
      qc.invalidateQueries({ queryKey: ['notifications-unread'] });
      return;
    }
    case 'dependencyChanged': {
      if (data?.fromIssueId) {
        qc.invalidateQueries({ queryKey: ['issue', data.fromIssueId, 'dependencies'] });
        qc.invalidateQueries({ queryKey: ['issue', data.fromIssueId] });
        qc.invalidateQueries({ queryKey: ['activities', data.fromIssueId] });
      }
      if (data?.toIssueId) {
        qc.invalidateQueries({ queryKey: ['issue', data.toIssueId, 'dependencies'] });
        qc.invalidateQueries({ queryKey: ['issue', data.toIssueId] });
        qc.invalidateQueries({ queryKey: ['activities', data.toIssueId] });
      }
      return;
    }
    case 'issue.unblockCascade':
    case 'dependency.unblocked': {
      // Subscribers in `features/issue/hooks/use-unblock-cascade.ts` consume
      // these directly via `wsClient.on`; React Query has nothing to refetch.
      return;
    }
    case 'pm.escalation': {
      // Web `usePmEscalations` is derived off `useNotifications`, so the
      // notifications invalidation is the only key that matters here.
      qc.invalidateQueries({ queryKey: ['notifications'] });
      qc.invalidateQueries({ queryKey: ['notifications-unread'] });
      // ISS-296 — refresh the PM decisions feed (`features/pm`).
      qc.invalidateQueries({ queryKey: ['pm', 'decisions'] });
      return;
    }
    case 'pat.created':
    case 'pat.revoked':
    case 'pat.used': {
      // ISS-160 — keep the /settings/tokens list in sync. The `pat.used`
      // event is throttled to 1/min/token in the dispatcher; we still
      // invalidate the list so last-used relative timestamps refresh.
      qc.invalidateQueries({ queryKey: ['tokens'] });
      return;
    }
    default: {
      // Unknown event: no-op. Log once per event kind in dev to surface
      // missing wiring on the client side.
      if (process.env.NODE_ENV !== 'production') {
        console.debug('[ws] unhandled event', event, data);
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
  qc.invalidateQueries({ queryKey: ['issues'] });
  qc.invalidateQueries({ queryKey: ['jobs'] });
  qc.invalidateQueries({ queryKey: ['projects'] });
  // ISS-291 — refresh the sessions index after a dropped connection.
  qc.invalidateQueries({ queryKey: ['agent-sessions'] });
  // ISS-292 — refresh any open conversation detail (`['agent-session', id, …]`)
  // so a session viewed across a reconnect re-pulls its turns + status.
  qc.invalidateQueries({ queryKey: ['agent-session'] });
  // ISS-296 — refresh the Runners / Activity / PM surfaces after a dropped
  // connection so their query keys re-pull anything visible.
  qc.invalidateQueries({ queryKey: ['devices'] });
  qc.invalidateQueries({ queryKey: ['runners'] });
  qc.invalidateQueries({ queryKey: ['activity'] });
  qc.invalidateQueries({ queryKey: ['pm'] });
}
