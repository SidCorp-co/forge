'use client';

import { useCallback, useEffect, useState, type ComponentType } from 'react';
import { Clock, AlertTriangle, X, CheckCircle2, RefreshCw, MessageSquare, Loader2 } from 'lucide-react';
import { agentApi } from '@/features/agent/api';
import {
  type AgentSession,
  type AgentSessionDisplayStatus,
  deriveSessionDisplayStatus,
} from '@/features/agent/api';
import { AGENT_STATUS_COLORS } from '@/lib/constants';
import { cn } from '@/lib/utils/cn';
import { relativeTime } from '@/lib/utils/relative-time';

interface SessionPlaceholderProps {
  sessionId: string;
  onRetry: () => Promise<void> | void;
  onCancel: () => Promise<void> | void;
}

const REFRESH_INTERVAL_MS = 10_000;

interface Presentation {
  Icon: ComponentType<{ className?: string }>;
  tone: string;
  label: string;
}

const PRESENTATION: Record<AgentSessionDisplayStatus, Presentation> = {
  idle: { Icon: Clock, tone: 'text-slate-400', label: 'Idle' },
  queued: {
    Icon: Clock,
    tone: 'text-violet-500 dark:text-violet-400',
    label: 'Queued',
  },
  running: {
    Icon: Clock,
    tone: 'text-blue-500 dark:text-blue-400',
    label: 'Running',
  },
  stalled: {
    Icon: AlertTriangle,
    tone: 'text-amber-500 dark:text-amber-400',
    label: 'Stalled',
  },
  completed: {
    Icon: CheckCircle2,
    tone: 'text-emerald-500 dark:text-emerald-400',
    label: 'Completed',
  },
  failed: {
    Icon: AlertTriangle,
    tone: 'text-red-500 dark:text-red-400',
    label: 'Failed',
  },
};

// Pipeline metadata + status surface for sessions with no messages yet —
// replaces the generic "Ask anything…" empty state which gave the user
// no signal when a worker had abandoned the session.
export function SessionPlaceholder({ sessionId, onRetry, onCancel }: SessionPlaceholderProps) {
  const [session, setSession] = useState<AgentSession | null>(null);
  const [retryPending, setRetryPending] = useState(false);
  const [cancelPending, setCancelPending] = useState(false);

  const fetchSession = useCallback(
    async (signal?: { cancelled: boolean }) => {
      try {
        const res = await agentApi.getSession(sessionId);
        if (signal?.cancelled) return;
        const wrapped = (res as unknown as { data?: AgentSession }).data;
        setSession(wrapped ?? (res as unknown as AgentSession));
      } catch {
        // Best-effort — keep prior session state on failure.
      }
    },
    [sessionId],
  );

  // Poll while non-terminal so the placeholder reflects live status changes
  // (queued → running, running → failed via sweeper, etc.). Without this the
  // placeholder would sit forever on its initial fetch — the very zombie
  // scenario this UI was meant to surface.
  useEffect(() => {
    const signal = { cancelled: false };
    void fetchSession(signal);
    const id = setInterval(() => {
      const status = session?.status;
      if (status === 'completed' || status === 'failed') return;
      void fetchSession(signal);
    }, REFRESH_INTERVAL_MS);
    return () => {
      signal.cancelled = true;
      clearInterval(id);
    };
  }, [fetchSession, session?.status]);

  const handleRetry = useCallback(async () => {
    if (retryPending) return;
    setRetryPending(true);
    try {
      await onRetry();
      await fetchSession();
    } finally {
      setRetryPending(false);
    }
  }, [retryPending, onRetry, fetchSession]);

  const handleCancel = useCallback(async () => {
    if (cancelPending) return;
    setCancelPending(true);
    try {
      await onCancel();
      await fetchSession();
    } finally {
      setCancelPending(false);
    }
  }, [cancelPending, onCancel, fetchSession]);

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
  const isPipeline = meta.type === 'pipeline' || meta.type === 'pm';

  // Interactive (non-pipeline) sessions get the standard empty state — no
  // Retry/Cancel CTAs (they'd 400 with NOT_PIPELINE_SESSION) and no
  // pipeline metadata block.
  if (!isPipeline) {
    return (
      <div className="flex-1 flex items-center justify-center bg-surface">
        <div className="text-center">
          <MessageSquare className="h-10 w-10 text-on-surface-variant mx-auto mb-3" />
          <p className="text-sm font-sans text-on-surface-variant">Ask anything about this project</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-auto bg-surface px-6 py-8">
      <div className="mx-auto max-w-xl space-y-4">
        <StatusHeadline display={display} session={session} />

        <div className="rounded-md border border-outline-variant/40 bg-surface-container-low p-4 text-sm text-on-surface space-y-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] uppercase tracking-wider text-on-surface-variant">
              Pipeline session
            </span>
            <StatusBadge display={display} />
          </div>
          <dl className="grid grid-cols-[110px_1fr] gap-x-3 gap-y-1.5 text-xs">
            {jobType && <PlaceholderField label="Job" value={jobType} mono />}
            {skillName && <PlaceholderField label="Skill" value={skillName} mono />}
            {issueId && <PlaceholderField label="Issue" value={issueId} mono />}
            {deviceId && <PlaceholderField label="Worker" value={deviceId} mono />}
            {session.dispatchedAt && (
              <PlaceholderField label="Dispatched" value={relativeTime(session.dispatchedAt)} />
            )}
            {session.lastHeartbeatAt && (
              <PlaceholderField label="Heartbeat" value={relativeTime(session.lastHeartbeatAt)} />
            )}
            {session.failureReason && (
              <PlaceholderField label="Reason" value={String(session.failureReason)} mono error />
            )}
          </dl>
        </div>

        {display !== 'completed' && (
          <div className="flex items-center gap-2">
            {/* Retry only on terminal failure — server enforces the same in
              * routes.ts /retry, but hide the button so users don't probe the
              * 409. */}
            {display === 'failed' && (
              <button
                type="button"
                onClick={handleRetry}
                disabled={retryPending}
                className="inline-flex items-center gap-1.5 rounded-sm border border-outline-variant/40 bg-surface-container px-3 py-1.5 text-xs font-medium text-on-surface hover:bg-surface-container-high disabled:cursor-not-allowed disabled:opacity-60"
              >
                {retryPending ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <RefreshCw className="h-3 w-3" />
                )}
                Retry
              </button>
            )}
            {display !== 'failed' && (
              <button
                type="button"
                onClick={handleCancel}
                disabled={cancelPending}
                className="inline-flex items-center gap-1.5 rounded-sm border border-outline-variant/40 bg-surface-container px-3 py-1.5 text-xs font-medium text-on-surface hover:bg-surface-container-high disabled:cursor-not-allowed disabled:opacity-60"
              >
                {cancelPending ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <X className="h-3 w-3" />
                )}
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

function PlaceholderField({
  label,
  value,
  mono,
  error,
}: {
  label: string;
  value: string;
  mono?: boolean;
  error?: boolean;
}) {
  return (
    <>
      <dt className="text-on-surface-variant">{label}</dt>
      <dd
        className={cn(
          'truncate',
          mono && 'font-mono',
          error ? 'text-error' : 'text-on-surface',
        )}
      >
        {value}
      </dd>
    </>
  );
}

function StatusHeadline({
  display,
  session,
}: {
  display: AgentSessionDisplayStatus;
  session: AgentSession;
}) {
  const { Icon, tone, label } = PRESENTATION[display];
  const elapsedFrom = session.dispatchedAt ?? session.startedAt ?? session.createdAt;
  const elapsed = elapsedFrom ? relativeTime(elapsedFrom) : null;

  return (
    <div className="flex items-center gap-3">
      <Icon className={cn('h-6 w-6', tone)} />
      <div>
        <div className="text-base font-semibold text-on-surface">{label}</div>
        {elapsed && <div className="text-xs text-on-surface-variant">{elapsed}</div>}
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
