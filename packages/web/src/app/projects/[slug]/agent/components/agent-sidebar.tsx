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

function statusTooltip(
  session: AgentSessionSummary,
  display: ReturnType<typeof deriveSessionDisplayStatus>,
): string | undefined {
  switch (display) {
    case 'running': {
      const stamp = session.lastHeartbeatAt ?? session.startedAt ?? session.updatedAt;
      return stamp ? `last activity ${relativeTime(stamp)}` : 'running';
    }
    case 'stalled': {
      const stamp = session.lastHeartbeatAt ?? session.startedAt ?? session.updatedAt;
      return stamp ? `no heartbeat since ${relativeTime(stamp)}` : 'no heartbeat';
    }
    case 'queued': {
      const stamp = session.dispatchedAt ?? session.createdAt;
      return stamp ? `waiting ${relativeTime(stamp)}` : 'waiting';
    }
    case 'failed':
      return session.failureReason
        ? `failed: ${session.failureReason}`
        : 'failed';
    case 'completed':
      return 'completed';
    case 'idle':
      return 'idle';
    default:
      return undefined;
  }
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
  // Force-tick every 15s so heartbeat-derived `running → stalled` flips on
  // schedule without waiting for a backend refetch.
  const [, tick] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    const id = setInterval(tick, 15_000);
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
            return <StatusDot status={display} title={statusTooltip(s, display)} />;
          }}
          getHref={(s) => `/projects/${slug}/agent?session=${s.documentId}`}
          theme="dark"
          onSearch={onSearch}
        />
      </div>
    </div>
  );
}
