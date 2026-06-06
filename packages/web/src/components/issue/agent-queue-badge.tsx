import { AlertTriangle, Check, X } from 'lucide-react';
import { AgentRunningDot } from '@/components/ui/agent-running-dot';
import { cn } from '@/lib/utils/cn';
import type { PipelineHealth, PipelineWaitingReason } from '@/features/issue/types';

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
  pipelineHealth?: PipelineHealth | null;
  className?: string;
  /** Reference time injected for deterministic tests; defaults to Date.now(). */
  now?: number;
}

// Tick freshness budget — matches the dispatcher health invariant in
// `packages/core/src/issues/pipeline-health.ts` (ISS-141 amendment §B).
const TICK_STALE_MS = 5 * 60 * 1000;

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

function describeWaiting(
  reason: PipelineWaitingReason,
  details: Record<string, unknown>,
): string {
  switch (reason) {
    case 'project_full': {
      const cap = typeof details.cap === 'number' ? details.cap : null;
      const running = Array.isArray(details.runningIssueIds)
        ? (details.runningIssueIds as unknown[])
            .filter((v): v is string => typeof v === 'string')
            .join(', ')
        : '';
      const capPart = cap !== null ? `cap ${cap}` : 'capacity reached';
      return running
        ? `Waiting: project at capacity (${capPart}, running: ${running}).`
        : `Waiting: project at capacity (${capPart}).`;
    }
    case 'runner_full': {
      const cap = typeof details.cap === 'number' ? details.cap : null;
      const inFlight = typeof details.inFlight === 'number' ? details.inFlight : null;
      if (cap !== null && inFlight !== null) {
        return `Waiting: runner at capacity (in-flight ${inFlight} / cap ${cap}).`;
      }
      return 'Waiting: runner at capacity.';
    }
    case 'waiting_on_dep': {
      const blockers = Array.isArray(details.blockerIssueIds)
        ? (details.blockerIssueIds as unknown[])
            .filter((v): v is string => typeof v === 'string')
            .join(', ')
        : '';
      return blockers
        ? `Waiting on blocker(s): ${blockers}.`
        : 'Waiting on unresolved blocker(s).';
    }
    case 'waiting_on_decomp_parent': {
      const parent = typeof details.parentIssueId === 'string' ? details.parentIssueId : null;
      return parent
        ? `Waiting on parent epic: ${parent}.`
        : 'Waiting on parent epic.';
    }
    case 'issue_busy':
      return 'Waiting: another job is active on this issue.';
    default:
      return 'Waiting on pipeline gate.';
  }
}

function formatClockTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

function formatRelative(iso: string, nowMs: number): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return iso;
  const diffMs = Math.max(0, nowMs - t);
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ${mins % 60}m ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

export function AgentQueueBadge({
  session,
  agentStatus,
  pipelineHealth,
  className,
  now,
}: AgentQueueBadgeProps) {
  const effectiveStatus: AgentQueueDerivedStatus =
    (session?.status as AgentQueueDerivedStatus | undefined) ?? agentStatus ?? null;

  if (!effectiveStatus || effectiveStatus === 'idle') return null;

  const skill = skillLabel(session);
  const label = skill ?? effectiveStatus;
  const wrapperClass = cn(
    'inline-flex items-center gap-1 text-[10px] uppercase tracking-widest text-on-surface-variant',
    className,
  );

  const nowMs = now ?? Date.now();
  const lastTickAtMs = pipelineHealth?.lastTickAt
    ? new Date(pipelineHealth.lastTickAt).getTime()
    : null;
  const tickStale =
    lastTickAtMs !== null &&
    !Number.isNaN(lastTickAtMs) &&
    nowMs - lastTickAtMs > TICK_STALE_MS;

  const tickStaleMarker = tickStale && pipelineHealth?.lastTickAt ? (
    <span
      role="img"
      tabIndex={0}
      aria-label={`Pipeline tick stale (last tick ${formatClockTime(pipelineHealth.lastTickAt)}) — dispatcher may be down`}
      title={`Pipeline tick stale (last tick ${formatClockTime(pipelineHealth.lastTickAt)}) — dispatcher may be down.`}
      className="inline-flex"
    >
      <AlertTriangle className="h-3 w-3 text-red-400" aria-hidden="true" />
    </span>
  ) : null;

  if (effectiveStatus === 'queued') {
    const waitingOn = pipelineHealth?.waitingOn ?? null;
    if (waitingOn) {
      const reasonText = describeWaiting(waitingOn.reason, waitingOn.details);
      const sinceRelative = formatRelative(waitingOn.since, nowMs);
      const tooltip = `${reasonText}\nQueued since ${sinceRelative}`;
      const ariaLabel = `Agent queued — ${reasonText} ${label}`;
      return (
        <span className={wrapperClass}>
          <span
            tabIndex={0}
            role="status"
            aria-label={ariaLabel}
            title={tooltip}
            className="inline-flex items-center gap-1 focus-visible:outline focus-visible:outline-1 focus-visible:outline-amber-400"
          >
            <span className="inline-block h-2 w-2 rounded-full bg-amber-400/80" aria-hidden="true" />
            <span>{label}</span>
          </span>
          {tickStaleMarker}
        </span>
      );
    }
    return (
      <span className={wrapperClass}>
        <span aria-label={`Agent queued: ${label}`} className="inline-flex items-center gap-1">
          <span className="inline-block h-2 w-2 rounded-full border border-violet-400/60" aria-hidden="true" />
          <span>{label}</span>
        </span>
        {tickStaleMarker}
      </span>
    );
  }

  if (effectiveStatus === 'running') {
    return (
      <span className={wrapperClass}>
        <span aria-label={`Agent running: ${label}`} className="inline-flex items-center gap-1">
          <AgentRunningDot size="sm" />
          <span>{label}</span>
        </span>
        {tickStaleMarker}
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
