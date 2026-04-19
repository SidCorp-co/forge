'use client';

import { useState } from 'react';
import { cn } from '@/lib/utils/cn';
import { apiClient } from '@/lib/api/client';
import { MessageSquare, Ban, RotateCcw, Loader2, Monitor, Server } from 'lucide-react';

interface AgentSession {
  id: number;
  documentId: string;
  title: string;
  status: string;
  metadata?: {
    noResume?: boolean;
    deviceName?: string;
    deviceId?: string;
    antigravityRunnerName?: string;
    runner?: string;
    skill?: string;
  } | null;
}

interface IssueAgentSessionsProps {
  sessions: AgentSession[];
  onSelect: (documentId: string) => void;
  onRefresh?: () => void;
}

export function IssueAgentSessions({ sessions, onSelect, onRefresh }: IssueAgentSessionsProps) {
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  if (!sessions || sessions.length === 0) return null;

  const handleToggleNoResume = async (e: React.MouseEvent, session: AgentSession) => {
    e.stopPropagation();
    setActionLoading(session.documentId);
    try {
      const current = session.metadata?.noResume ?? false;
      await apiClient(`/agent-sessions/${session.documentId}`, {
        method: 'PUT',
        body: JSON.stringify({ data: { metadata: { ...session.metadata, noResume: !current } } }),
      });
      onRefresh?.();
    } catch (err) {
      console.error('Failed to toggle noResume:', err);
    }
    setActionLoading(null);
  };

  return (
    <div className="p-4 space-y-2">
      <ul className="space-y-2">
        {sessions.map((s) => {
          const meta = s.metadata || {};
          const isTerminal = s.status === 'completed' || s.status === 'failed';

          return (
            <li key={s.id}>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => onSelect(s.documentId)}
                  className="flex flex-1 items-center gap-3 rounded-sm border border-outline-variant/30 bg-surface-container-low px-4 py-3 text-left text-xs font-mono tracking-widest text-tertiary hover:bg-surface-container-high hover:text-on-surface transition-colors uppercase min-w-0"
                >
                  <MessageSquare className="h-4 w-4 shrink-0 text-outline" />
                  <div className="min-w-0 flex-1">
                    <span className="block truncate">{s.title}</span>
                    {(meta.deviceName || meta.antigravityRunnerName) && (
                      <span className="flex items-center gap-1 text-[9px] text-on-surface-variant mt-0.5 normal-case tracking-normal">
                        {meta.deviceName ? <Monitor className="h-2.5 w-2.5" /> : <Server className="h-2.5 w-2.5" />}
                        {meta.deviceName || meta.antigravityRunnerName}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {meta.noResume && (
                      <span className="text-[9px] font-bold text-warning tracking-widest">NO RESUME</span>
                    )}
                    <span className={cn(
                      'rounded-sm px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest',
                      s.status === 'running' ? 'bg-primary text-on-primary' : 'border border-outline-variant/30 bg-surface text-on-surface-variant'
                    )}>
                      {s.status}
                    </span>
                  </div>
                </button>
                {isTerminal && (
                  <button
                    onClick={(e) => handleToggleNoResume(e, s)}
                    disabled={actionLoading === s.documentId}
                    className={cn(
                      'shrink-0 rounded-sm p-2 transition-colors disabled:opacity-50',
                      meta.noResume
                        ? 'text-warning hover:text-on-surface bg-warning/10 border border-warning/30'
                        : 'text-on-surface-variant hover:text-warning border border-outline-variant/30 hover:border-warning/30',
                    )}
                    title={meta.noResume ? 'Allow resume' : 'Block resume'}
                  >
                    {actionLoading === s.documentId
                      ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      : meta.noResume ? <RotateCcw className="h-3.5 w-3.5" /> : <Ban className="h-3.5 w-3.5" />
                    }
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
