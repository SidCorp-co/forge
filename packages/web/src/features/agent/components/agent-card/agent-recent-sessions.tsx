'use client';

import { CheckCircle2, Clock, Hourglass, Loader2, XCircle } from 'lucide-react';
import type { AgentSessionSummary } from '../../api';

interface AgentRecentSessionsProps {
  sessions: AgentSessionSummary[];
  onSessionClick: (sessionId: string) => void;
}

export function AgentRecentSessions({ sessions, onSessionClick }: AgentRecentSessionsProps) {
  if (sessions.length === 0) return null;

  return (
    <div className="border-t border-outline-variant/20 p-5">
      <h4 className="mb-3 text-sm font-medium text-on-surface-variant">Recent Runs</h4>
      <div className="space-y-1.5">
        {sessions.map((s) => (
          <button
            key={s.documentId}
            onClick={() => onSessionClick(s.documentId)}
            className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm hover:bg-surface-container-low"
          >
            {s.status === 'completed' ? (
              <CheckCircle2 className="h-4 w-4 shrink-0 text-success" />
            ) : s.status === 'running' ? (
              <Loader2 className="h-4 w-4 shrink-0 animate-spin text-info" />
            ) : s.status === 'queued' ? (
              <Hourglass className="h-4 w-4 shrink-0 text-warning" />
            ) : s.status === 'failed' ? (
              <XCircle className="h-4 w-4 shrink-0 text-danger" />
            ) : (
              <Clock className="h-4 w-4 shrink-0 text-outline" />
            )}
            <span className="min-w-0 flex-1 truncate text-on-surface">{s.title}</span>
            <span className="shrink-0 text-xs text-outline">
              {new Date(s.createdAt).toLocaleDateString()}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
