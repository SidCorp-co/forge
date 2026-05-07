'use client';

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
      if (data?.issueId) {
        qc.invalidateQueries({ queryKey: ['issue', data.issueId] });
      }
      return;
    }
    case 'issue.statusChanged': {
      qc.invalidateQueries({ queryKey: ['issues', 'list'] });
      qc.invalidateQueries({ queryKey: ['issues', 'search'] });
      if (data?.issueId) {
        qc.invalidateQueries({ queryKey: ['issue', data.issueId] });
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
    case 'device.statusChanged': {
      qc.invalidateQueries({ queryKey: ['admin', 'devices'] });
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
      // React Query prefix-matches, so invalidating ['issue', uuid] also
      // invalidates ['issue', uuid, 'dependencies'] — no separate call needed.
      if (data?.fromIssueId) {
        qc.invalidateQueries({ queryKey: ['issue', data.fromIssueId] });
      }
      if (data?.toIssueId) {
        qc.invalidateQueries({ queryKey: ['issue', data.toIssueId] });
      }
      return;
    }
    case 'pm.escalation': {
      // Web `usePmEscalations` is derived off `useNotifications`, so the
      // notifications invalidation is the only key that matters here.
      qc.invalidateQueries({ queryKey: ['notifications'] });
      qc.invalidateQueries({ queryKey: ['notifications-unread'] });
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
}
