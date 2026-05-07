'use client';

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { MessageSquare, Ban, RotateCcw, Loader2, Monitor, Server } from 'lucide-react';
import { cn } from '@/lib/utils/cn';
import { apiClient } from '@/lib/api/client';
import { Skeleton } from '@/components/ui';

interface AgentSessionRow {
  id: string;
  projectId: string;
  deviceId: string | null;
  title: string | null;
  status: string;
  metadata: {
    issueId?: string;
    deviceName?: string;
    antigravityRunnerName?: string;
    runner?: string;
    skill?: string;
    noResume?: boolean;
  } | null;
  startedAt: string | null;
  endedAt: string | null;
  updatedAt: string;
  createdAt: string;
}

interface IssueAgentSessionsProps {
  issueId: string;
  onSelect: (sessionId: string) => void;
  selectedSessionId?: string | null;
}

export const issueAgentSessionsKey = (issueId: string | undefined) =>
  ['agent-sessions', 'by-issue', issueId] as const;

export function IssueAgentSessions({ issueId, onSelect, selectedSessionId }: IssueAgentSessionsProps) {
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  const sessionsQuery = useQuery({
    queryKey: issueAgentSessionsKey(issueId),
    queryFn: () =>
      apiClient<AgentSessionRow[]>(`/agent-sessions?issueId=${issueId}&pageSize=50`),
    enabled: !!issueId,
    staleTime: 10_000,
    refetchOnWindowFocus: true,
  });

  const sessions = useMemo(() => sessionsQuery.data ?? [], [sessionsQuery.data]);

  const handleToggleNoResume = async (e: React.MouseEvent, session: AgentSessionRow) => {
    e.stopPropagation();
    setActionLoading(session.id);
    try {
      const current = session.metadata?.noResume ?? false;
      await apiClient(`/agent-sessions/${session.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ metadata: { ...(session.metadata ?? {}), noResume: !current } }),
      });
      sessionsQuery.refetch();
    } catch (err) {
      console.error('Failed to toggle noResume:', err);
    }
    setActionLoading(null);
  };

  return (
    <section className="rounded-sm border border-outline-variant/20 bg-surface">
      <div className="border-b border-outline-variant/20 bg-surface-container-low px-4 py-2">
        <h3 className="text-[10px] font-bold uppercase tracking-[0.2em] text-on-surface-variant">
          Agent sessions
        </h3>
      </div>
      <div className="p-4">
        {sessionsQuery.isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : sessions.length === 0 ? (
          <p className="text-[11px] text-outline">Chưa có phiên.</p>
        ) : (
          <ul className="space-y-2">
            {sessions.map((s) => {
              const meta = s.metadata ?? {};
              const isTerminal = s.status === 'completed' || s.status === 'failed';
              const title = s.title ?? `Session ${s.id.slice(0, 8)}`;
              const isSelected = selectedSessionId === s.id;
              return (
                <li key={s.id}>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => onSelect(s.id)}
                      className={cn(
                        'flex flex-1 items-center gap-3 rounded-sm border px-4 py-3 text-left text-xs font-mono tracking-widest transition-colors uppercase min-w-0',
                        isSelected
                          ? 'border-primary/40 bg-primary/10 text-on-surface'
                          : 'border-outline-variant/30 bg-surface-container-low text-tertiary hover:bg-surface-container-high hover:text-on-surface',
                      )}
                    >
                      <MessageSquare className="h-4 w-4 shrink-0 text-outline" />
                      <div className="min-w-0 flex-1">
                        <span className="block truncate">{title}</span>
                        {(meta.deviceName || meta.antigravityRunnerName || meta.skill) && (
                          <span className="mt-0.5 flex items-center gap-1 text-[9px] text-on-surface-variant normal-case tracking-normal">
                            {meta.deviceName ? <Monitor className="h-2.5 w-2.5" /> : <Server className="h-2.5 w-2.5" />}
                            {meta.skill ?? meta.deviceName ?? meta.antigravityRunnerName}
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        {meta.noResume && (
                          <span className="text-[9px] font-bold text-warning tracking-widest">NO RESUME</span>
                        )}
                        <span
                          className={cn(
                            'rounded-sm px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest',
                            s.status === 'running'
                              ? 'bg-primary text-on-primary'
                              : 'border border-outline-variant/30 bg-surface text-on-surface-variant',
                          )}
                        >
                          {s.status}
                        </span>
                      </div>
                    </button>
                    {isTerminal && (
                      <button
                        onClick={(e) => handleToggleNoResume(e, s)}
                        disabled={actionLoading === s.id}
                        className={cn(
                          'shrink-0 rounded-sm p-2 transition-colors disabled:opacity-50',
                          meta.noResume
                            ? 'text-warning hover:text-on-surface bg-warning/10 border border-warning/30'
                            : 'text-on-surface-variant hover:text-warning border border-outline-variant/30 hover:border-warning/30',
                        )}
                        title={meta.noResume ? 'Allow resume' : 'Block resume'}
                      >
                        {actionLoading === s.id ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : meta.noResume ? (
                          <RotateCcw className="h-3.5 w-3.5" />
                        ) : (
                          <Ban className="h-3.5 w-3.5" />
                        )}
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}
