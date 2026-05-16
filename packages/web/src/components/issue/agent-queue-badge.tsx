import { Check, X } from 'lucide-react';
import { AgentRunningDot } from '@/components/ui/agent-running-dot';
import { cn } from '@/lib/utils/cn';

export type AgentSessionStatus =
  | 'idle'
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | string;

export interface AgentQueueBadgeSession {
  status: AgentSessionStatus;
  metadata?: Record<string, unknown> | null;
}

export type AgentQueueDerivedStatus =
  | 'idle'
  | 'running'
  | 'queued'
  | 'completed'
  | 'failed'
  | null;

interface AgentQueueBadgeProps {
  session?: AgentQueueBadgeSession | null;
  agentStatus?: AgentQueueDerivedStatus;
  className?: string;
}

// Pick the most relevant session for display: a `running` one wins over a
// `queued` one; otherwise return null and let the caller decide whether to
// render anything based on `agentStatus`.
export function pickActiveSession<T extends AgentQueueBadgeSession>(
  sessions: readonly T[] | null | undefined,
): T | null {
  if (!sessions || sessions.length === 0) return null;
  return (
    sessions.find((s) => s.status === 'running') ??
    sessions.find((s) => s.status === 'queued') ??
    null
  );
}

function skillLabel(session: AgentQueueBadgeSession | null | undefined): string | null {
  const skill = session?.metadata?.skill;
  return typeof skill === 'string' && skill.length > 0 ? skill : null;
}

export function AgentQueueBadge({ session, agentStatus, className }: AgentQueueBadgeProps) {
  const effectiveStatus: AgentQueueDerivedStatus =
    (session?.status as AgentQueueDerivedStatus | undefined) ?? agentStatus ?? null;

  if (!effectiveStatus || effectiveStatus === 'idle') return null;

  const skill = skillLabel(session);
  const label = skill ?? effectiveStatus;
  const wrapperClass = cn(
    'inline-flex items-center gap-1 text-[10px] uppercase tracking-widest text-on-surface-variant',
    className,
  );

  if (effectiveStatus === 'queued') {
    return (
      <span className={wrapperClass} aria-label={`Agent queued: ${label}`}>
        <span className="inline-block h-2 w-2 rounded-full border border-violet-400/60" />
        <span>{label}</span>
      </span>
    );
  }

  if (effectiveStatus === 'running') {
    return (
      <span className={wrapperClass} aria-label={`Agent running: ${label}`}>
        <AgentRunningDot size="sm" />
        <span>{label}</span>
      </span>
    );
  }

  if (effectiveStatus === 'completed') {
    return (
      <span className={wrapperClass} aria-label={`Agent completed: ${label}`}>
        <Check className="h-3 w-3 text-emerald-400" />
        <span>{label}</span>
      </span>
    );
  }

  if (effectiveStatus === 'failed') {
    return (
      <span className={wrapperClass} aria-label={`Agent failed: ${label}`}>
        <X className="h-3 w-3 text-red-400" />
        <span>{label}</span>
      </span>
    );
  }

  return null;
}
