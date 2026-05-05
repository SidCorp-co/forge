'use client';

import { useEffect, useState } from 'react';
import { Clock, AlertTriangle, X, CheckCircle2, RefreshCw } from 'lucide-react';
import { agentApi } from '@/features/agent/api';
import {
  type AgentSession,
  type AgentSessionDisplayStatus,
  deriveSessionDisplayStatus,
} from '@/features/agent/api';
import { AGENT_STATUS_COLORS } from '@/lib/constants';
import { cn } from '@/lib/utils/cn';

interface SessionPlaceholderProps {
  sessionId: string;
  onRetry?: () => void;
  onCancel?: () => void;
}

/**
 * ISS-34 — render a useful empty state when a session has no messages yet.
 *
 * Pipeline sessions are inserted with status='queued' before any worker
 * claims them. If the worker is offline (or crashes mid-claim) the session
 * sits at queued/running with `messages=[]`. Before this component, the UI
 * showed the generic "Ask anything about this project" empty state, leaving
 * the user with no signal about what was actually happening.
 *
 * This block surfaces:
 *   • Pipeline metadata (jobType, skillName, link to issue)
 *   • Resolved display status (queued / running / stalled / failed)
 *   • Elapsed time since dispatch
 *   • Failure reason when terminal
 *   • Retry / Cancel CTAs (wired by parent in PR 2)
 */
export function SessionPlaceholder({ sessionId, onRetry, onCancel }: SessionPlaceholderProps) {
  const [session, setSession] = useState<AgentSession | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let alive = true;
    agentApi
      .getSession(sessionId)
      .then((res) => {
        if (!alive) return;
        const wrapped = (res as unknown as { data?: AgentSession }).data;
        setSession(wrapped ?? (res as unknown as AgentSession));
      })
      .catch(() => {
        // Best-effort — if we can't load the session, fall back to minimal UI.
      });
    return () => {
      alive = false;
    };
  }, [sessionId]);

  // Bump every 10s so elapsed time + derived stalled status stay current.
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 10_000);
    return () => clearInterval(id);
  }, []);

  if (!session) {
    return (
      <div className="flex-1 flex items-center justify-center bg-surface">
        <div className="text-xs text-on-surface-variant">Loading session…</div>
      </div>
    );
  }

  const display = deriveSessionDisplayStatus(session);
  const meta = (session.metadata ?? {}) as Record<string, unknown>;
  const jobType = (meta.jobType as string | undefined) ?? null;
  const skillName = (meta.skillName as string | undefined) ?? null;
  const issueId = (meta.issueId as string | undefined) ?? null;
  const deviceId =
    (meta.deviceId as string | undefined) ??
    ((session as unknown as { deviceId?: string }).deviceId ?? null);
  const isPipeline = (meta.type === 'pipeline' || meta.type === 'pm') as boolean;

  return (
    <div className="flex-1 overflow-auto bg-surface px-6 py-8">
      <div className="mx-auto max-w-xl space-y-4">
        <StatusHeadline display={display} session={session} tick={tick} />

        {isPipeline && (
          <div className="rounded-md border border-outline-variant/40 bg-surface-container-low p-4 text-sm text-on-surface space-y-2">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11px] uppercase tracking-wider text-on-surface-variant">
                Pipeline session
              </span>
              <StatusBadge display={display} />
            </div>
            <dl className="grid grid-cols-[110px_1fr] gap-x-3 gap-y-1.5 text-xs">
              {jobType && (
                <>
                  <dt className="text-on-surface-variant">Job</dt>
                  <dd className="font-mono text-on-surface">{jobType}</dd>
                </>
              )}
              {skillName && (
                <>
                  <dt className="text-on-surface-variant">Skill</dt>
                  <dd className="font-mono text-on-surface">{skillName}</dd>
                </>
              )}
              {issueId && (
                <>
                  <dt className="text-on-surface-variant">Issue</dt>
                  <dd className="font-mono text-on-surface truncate">{issueId}</dd>
                </>
              )}
              {deviceId && (
                <>
                  <dt className="text-on-surface-variant">Worker</dt>
                  <dd className="font-mono text-on-surface truncate">{deviceId}</dd>
                </>
              )}
              {session.dispatchedAt && (
                <>
                  <dt className="text-on-surface-variant">Dispatched</dt>
                  <dd className="text-on-surface">{formatRelative(session.dispatchedAt)}</dd>
                </>
              )}
              {session.lastHeartbeatAt && (
                <>
                  <dt className="text-on-surface-variant">Heartbeat</dt>
                  <dd className="text-on-surface">{formatRelative(session.lastHeartbeatAt)}</dd>
                </>
              )}
              {session.failureReason && (
                <>
                  <dt className="text-on-surface-variant">Reason</dt>
                  <dd className="font-mono text-error">{String(session.failureReason)}</dd>
                </>
              )}
            </dl>
          </div>
        )}

        {(onRetry || onCancel) && display !== 'completed' && (
          <div className="flex items-center gap-2">
            {onRetry && (
              <button
                type="button"
                onClick={onRetry}
                className="inline-flex items-center gap-1.5 rounded-sm border border-outline-variant/40 bg-surface-container px-3 py-1.5 text-xs font-medium text-on-surface hover:bg-surface-container-high"
              >
                <RefreshCw className="h-3 w-3" />
                Retry
              </button>
            )}
            {onCancel && display !== 'failed' && (
              <button
                type="button"
                onClick={onCancel}
                className="inline-flex items-center gap-1.5 rounded-sm border border-outline-variant/40 bg-surface-container px-3 py-1.5 text-xs font-medium text-on-surface hover:bg-surface-container-high"
              >
                <X className="h-3 w-3" />
                Cancel
              </button>
            )}
          </div>
        )}

        {display === 'queued' && (
          <p className="text-xs text-on-surface-variant">
            Waiting for a worker to pick up this job. If no worker is online, the sweeper
            will fail this session after the queue timeout.
          </p>
        )}
        {display === 'stalled' && (
          <p className="text-xs text-on-surface-variant">
            The worker has not sent a heartbeat recently. The sweeper will mark this
            session as failed if heartbeat does not resume.
          </p>
        )}
      </div>
    </div>
  );
}

function StatusHeadline({
  display,
  session,
  tick,
}: {
  display: AgentSessionDisplayStatus;
  session: AgentSession;
  tick: number;
}) {
  // tick keeps the elapsed-time string fresh.
  void tick;
  const elapsedFrom = session.dispatchedAt ?? session.startedAt ?? session.createdAt;
  const elapsed = elapsedFrom ? formatRelative(elapsedFrom) : null;

  const Icon =
    display === 'queued'
      ? Clock
      : display === 'stalled' || display === 'failed'
        ? AlertTriangle
        : display === 'completed'
          ? CheckCircle2
          : Clock;

  const tone =
    display === 'queued'
      ? 'text-violet-500 dark:text-violet-400'
      : display === 'stalled'
        ? 'text-amber-500 dark:text-amber-400'
        : display === 'failed'
          ? 'text-red-500 dark:text-red-400'
          : display === 'completed'
            ? 'text-emerald-500 dark:text-emerald-400'
            : 'text-blue-500 dark:text-blue-400';

  const label =
    display === 'queued'
      ? 'Queued'
      : display === 'running'
        ? 'Running'
        : display === 'stalled'
          ? 'Stalled'
          : display === 'completed'
            ? 'Completed'
            : display === 'failed'
              ? 'Failed'
              : 'Idle';

  return (
    <div className="flex items-center gap-3">
      <Icon className={cn('h-6 w-6', tone)} />
      <div>
        <div className="text-base font-semibold text-on-surface">{label}</div>
        {elapsed && (
          <div className="text-xs text-on-surface-variant">{elapsed}</div>
        )}
      </div>
    </div>
  );
}

function StatusBadge({ display }: { display: AgentSessionDisplayStatus }) {
  return (
    <span
      className={cn(
        'rounded px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider',
        AGENT_STATUS_COLORS[display] ?? 'bg-slate-100 text-slate-500',
      )}
    >
      {display}
    </span>
  );
}

function formatRelative(ts: string): string {
  const dt = new Date(ts).getTime();
  if (Number.isNaN(dt)) return ts;
  const diff = Date.now() - dt;
  const abs = Math.abs(diff);
  const min = Math.floor(abs / 60_000);
  const sec = Math.floor((abs % 60_000) / 1_000);
  const sign = diff >= 0 ? '' : 'in ';
  if (abs < 60_000) return `${sign}${sec}s ago`;
  if (abs < 3_600_000) return `${sign}${min}m ${sec}s ago`;
  const hr = Math.floor(min / 60);
  return `${sign}${hr}h ${min % 60}m ago`;
}
