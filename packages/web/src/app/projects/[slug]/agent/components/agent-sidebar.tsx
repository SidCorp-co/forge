'use client';

import { Plus, Monitor, MonitorOff } from 'lucide-react';
import { SessionList } from '@/components/chat/session-list';
import { Button, StatusDot } from '@/components/ui';
import { cn } from '@/lib/utils/cn';
import { deriveSessionDisplayStatus } from '@/features/agent/api';
import type { AgentSessionSummary } from '@/features/agent/api';
import { renderGatedTooltip } from '@/features/agent/gated-tooltip';
import { useUnblockedIssueIds } from '@/features/issue/hooks/use-unblock-cascade';
import { relativeTime } from '@/lib/utils/relative-time';

interface AgentSidebarProps {
  slug: string;
  sessions: AgentSessionSummary[];
  loadingSessions: boolean;
  activeSessionId: string | null;
  desktopConnected: boolean;
  showSessions: boolean;
  onNewChat: () => void;
  onSelectSession: (session: AgentSessionSummary) => void;
  onSearch: (query: string) => void;
  width?: number;
}

export function AgentSidebar({
  slug,
  sessions,
  loadingSessions,
  activeSessionId,
  desktopConnected,
  showSessions,
  onNewChat,
  onSelectSession,
  onSearch,
  width,
}: AgentSidebarProps) {
  // No local timer: heartbeat-derived `stalled` flips when the parent's
  // `useAgentSessions` refetches (15s while a stream is running).
  const { ids: unblockedIssueIds, blockerSeqFor } = useUnblockedIssueIds();
  function sessionIssueId(s: AgentSessionSummary): string | null {
    const meta = (s.metadata ?? {}) as Record<string, unknown>;
    const id = meta.issueId;
    return typeof id === 'string' ? id : null;
  }

  return (
    <aside
      aria-label="Agent sessions"
      className={cn(
        'w-full shrink-0 border-r border-surface-variant flex flex-col bg-surface',
        !showSessions && 'hidden md:flex',
      )}
      style={{ width: width ? `${width}px` : undefined }}
    >
      <div className="flex items-center justify-between border-b border-surface-variant px-4 py-3">
        <h3 className="text-sm font-semibold text-on-surface-variant">Sessions</h3>
        <Button size="xs" onClick={onNewChat} className="flex items-center gap-1">
          <Plus className="h-3 w-3" />
          New
        </Button>
      </div>

      <div className="flex items-center gap-2 px-4 py-2 border-b border-surface-variant text-xs">
        {desktopConnected ? (
          <>
            <Monitor className="h-3.5 w-3.5 text-success" />
            <span className="text-success">Desktop connected</span>
          </>
        ) : (
          <>
            <MonitorOff className="h-3.5 w-3.5 text-primary-fixed" />
            <span className="text-primary-fixed">Desktop offline</span>
          </>
        )}
      </div>

      <div className="flex-1 overflow-y-auto overscroll-contain">
        <SessionList
          sessions={sessions}
          loading={loadingSessions}
          activeSessionId={activeSessionId}
          onSelect={onSelectSession}
          onNew={onNewChat}
          statusDot={(s) => {
            const display = deriveSessionDisplayStatus(s);
            const lastSignal = s.lastHeartbeatAt ?? s.startedAt ?? s.updatedAt;
            const elapsed = lastSignal ? relativeTime(lastSignal) : null;
            let title: string = display;
            if (display === 'running' && elapsed) {
              title = `running · last activity ${elapsed}`;
            } else if (display === 'stalled' && elapsed) {
              title = `stalled · no heartbeat ${elapsed}`;
            } else if (display === 'queued') {
              // ISS-40 PR-E — sessions skipped by the dispatcher's 4-layer
              // gating stay queued and surface a typed reason on
              // `failureReason`. Use it to render a more useful tooltip
              // than a generic "waiting for worker".
              const gateTitle = renderGatedTooltip(s);
              if (gateTitle) {
                title = gateTitle;
              } else {
                const dispatched = s.dispatchedAt ? relativeTime(s.dispatchedAt) : null;
                title = dispatched
                  ? `queued · waiting ${dispatched}`
                  : 'queued · waiting for worker';
              }
            } else if (display === 'failed' && s.failureReason) {
              title = `failed · ${String(s.failureReason)}`;
            }
            return <StatusDot status={display} title={title} />;
          }}
          getHref={(s) => `/projects/${slug}/agent?session=${s.documentId}`}
          theme="dark"
          onSearch={onSearch}
          rowClassName={(s) => {
            const issueId = sessionIssueId(s);
            return issueId && unblockedIssueIds.has(issueId)
              ? 'animate-amber-pulse'
              : undefined;
          }}
          rowTitle={(s) => {
            const issueId = sessionIssueId(s);
            if (!issueId || !unblockedIssueIds.has(issueId)) return undefined;
            const seq = blockerSeqFor(issueId);
            return seq != null ? `Unblocked by ISS-${seq}` : 'Unblocked';
          }}
        />
      </div>
    </aside>
  );
}
