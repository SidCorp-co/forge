'use client';

import type { AgentSessionSummary } from '@/features/agent/api';
import { AgentRunningDot } from '@/components/ui/agent-running-dot';
import { Clock, CheckCircle2, XCircle } from 'lucide-react';

interface PipelineFeedProps {
  running: AgentSessionSummary[];
  queued: AgentSessionSummary[];
  recentCompleted: AgentSessionSummary[];
}

// Colored status badge — semantic tokens so dark mode is automatic.
const STATUS_BADGE: Record<string, string> = {
  running: 'bg-primary/15 text-primary',
  queued: 'bg-outline-variant/40 text-on-surface-variant',
  completed: 'bg-success/15 text-success',
  failed: 'bg-error/15 text-error',
};

function formatElapsed(dateStr: string): string {
  const ms = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return '<1m';
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

export function PipelineFeed({ running, queued, recentCompleted }: PipelineFeedProps) {
  const all = [...running, ...queued, ...recentCompleted].slice(0, 15);

  if (all.length === 0) {
    return <p className="text-xs text-outline py-4 text-center">No recent pipeline activity</p>;
  }

  return (
    <div className="max-h-[400px] overflow-y-auto space-y-1">
      {all.map((s) => {
        const skill = (s.metadata as any)?.skill as string | undefined;
        return (
          <div key={s.documentId} className="flex items-center gap-2 px-2 py-1.5 rounded-sm hover:bg-surface-container-high transition-colors">
            {s.status === 'running' && <AgentRunningDot />}
            {s.status === 'queued' && <Clock className="h-3.5 w-3.5 text-outline animate-pulse" />}
            {s.status === 'completed' && <CheckCircle2 className="h-3.5 w-3.5 text-success" />}
            {s.status === 'failed' && <XCircle className="h-3.5 w-3.5 text-error" />}
            <div className="flex-1 min-w-0">
              {skill && <span className="text-[10px] font-mono text-outline uppercase tracking-wider">{skill} </span>}
              <span className="text-xs text-on-surface-variant truncate">{s.title}</span>
            </div>
            <span
              className={`shrink-0 rounded-sm px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-widest ${STATUS_BADGE[s.status] ?? 'bg-outline-variant/40 text-on-surface-variant'}`}
            >
              {s.status}
            </span>
            <span className="text-[10px] font-mono text-outline tabular-nums shrink-0">
              {formatElapsed(s.updatedAt)}
            </span>
          </div>
        );
      })}
    </div>
  );
}
