'use client';

import { useEffect, useReducer } from 'react';
import { Plus, Monitor, MonitorOff } from 'lucide-react';
import { SessionList } from '@/components/chat/session-list';
import { Button, StatusDot } from '@/components/ui';
import { cn } from '@/lib/utils/cn';
import {
  AGENT_INTERACTIVE_ENABLED,
  deriveSessionDisplayStatus,
} from '@/features/agent/api';
import type { AgentSessionSummary } from '@/features/agent/api';
import { renderGatedTooltip } from '@/features/agent/gated-tooltip';
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
  // Re-render every 15s so heartbeat-derived `stalled` flips on schedule
  // without waiting for the parent's react-query refetch. The session row
  // doesn't change between these ticks; only the rendered display state does.
  const [, forceTick] = useReducer((c: number) => c + 1, 0);
  useEffect(() => {
    const id = setInterval(forceTick, 15_000);
    return () => clearInterval(id);
  }, []);

  return (
    <div
      className={cn(
        'w-full shrink-0 border-r border-surface-variant flex flex-col bg-surface',
        !showSessions && 'hidden md:flex',
      )}
      style={{ width: width ? `${width}px` : undefined }}
    >
      <div className="flex items-center justify-between border-b border-surface-variant px-4 py-3">
        <h3 className="text-sm font-semibold text-on-surface-variant">Sessions</h3>
        {AGENT_INTERACTIVE_ENABLED && (
          <Button size="xs" onClick={onNewChat} className="flex items-center gap-1">
            <Plus className="h-3 w-3" />
            New
          </Button>
        )}
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
        />
      </div>
    </div>
  );
}
