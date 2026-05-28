'use client';

import { useEffect, useReducer } from 'react';
import Link from 'next/link';
import { AlertTriangle, Clock, Workflow } from 'lucide-react';
import type { Job } from '@forge/contracts';
import { AgentRunningDot } from '@/components/ui/agent-running-dot';
import { Skeleton } from '@/components/ui/skeleton';
import { formatApiError } from '@/lib/api/error';
import type { PipelineRunKind } from '@/features/pipeline-run/types';
import {
  RUNNER_CAP,
  usePipelineActivityJobs,
  type RunnerCapacity,
} from '../hooks/use-pipeline-activity-jobs';

interface PipelineActivityPanelProps {
  projectId: string;
  slug: string;
}

// Job timestamp columns are typed as Date by Drizzle's $inferSelect, but the
// JSON wire payload delivers ISO strings; new Date(...) accepts either.
function formatElapsed(value: Date | string | null): string {
  if (!value) return '—';
  const ms = Date.now() - new Date(value).getTime();
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return '<1m';
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function shortDevice(deviceId: string | null): string {
  if (!deviceId) return 'unassigned';
  return deviceId.slice(0, 8);
}

export function PipelineActivityPanel({ projectId, slug }: PipelineActivityPanelProps) {
  const { running, queued, runKindById, capacity, stuckIds, isLoading, error } =
    usePipelineActivityJobs(projectId);

  // Elapsed timers + stuck badges derive from Date.now(); tick every 30s so
  // they advance between WS-driven refetches.
  const [, tick] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    const id = setInterval(tick, 30_000);
    return () => clearInterval(id);
  }, []);

  return (
    <section className="space-y-2">
      <h2 className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-[0.2em] text-on-surface-variant">
        <Workflow className="h-3.5 w-3.5" />
        Pipeline activity
      </h2>
      {isLoading ? (
        <Skeleton className="h-24" />
      ) : error ? (
        <div className="rounded-sm border border-error/30 bg-error-container/10 p-3 text-xs text-error">
          {formatApiError(error)}
        </div>
      ) : (
        <PipelineActivityBody
          running={running}
          queued={queued}
          runKindById={runKindById}
          capacity={capacity}
          stuckIds={stuckIds}
          slug={slug}
        />
      )}
    </section>
  );
}

interface BodyProps {
  running: Job[];
  queued: Job[];
  runKindById: Map<string, PipelineRunKind>;
  capacity: RunnerCapacity[];
  stuckIds: Set<string>;
  slug: string;
}

function PipelineActivityBody({
  running,
  queued,
  runKindById,
  capacity,
  stuckIds,
  slug,
}: BodyProps) {
  return (
    <div className="space-y-3">
      <CapacityLine capacity={capacity} />

      {running.length === 0 && queued.length === 0 ? (
        <p className="text-xs text-outline">No in-flight or queued jobs.</p>
      ) : (
        <>
          {running.length > 0 && (
            <JobSection title="Running">
              {running.map((job) => (
                <JobRow
                  key={job.id}
                  job={job}
                  runKindById={runKindById}
                  slug={slug}
                  timeRef={job.dispatchedAt ?? job.queuedAt}
                  stuck={stuckIds.has(job.id)}
                />
              ))}
            </JobSection>
          )}
          {queued.length > 0 && (
            <JobSection title="Waiting">
              {queued.map((job) => (
                <JobRow
                  key={job.id}
                  job={job}
                  runKindById={runKindById}
                  slug={slug}
                  timeRef={job.queuedAt}
                  waiting
                />
              ))}
            </JobSection>
          )}
        </>
      )}
    </div>
  );
}

function CapacityLine({ capacity }: { capacity: RunnerCapacity[] }) {
  if (capacity.length === 0) {
    return <p className="text-[10px] uppercase tracking-widest text-outline">No active runner</p>;
  }
  return (
    <ul className="flex flex-wrap gap-2 text-[10px] uppercase tracking-widest">
      {capacity.map((c) => (
        <li
          key={c.deviceId ?? 'unassigned'}
          className={`inline-flex items-center gap-1.5 rounded-sm px-2 py-0.5 ${
            c.full ? 'text-warning' : 'text-on-surface-variant'
          }`}
        >
          <span className="font-mono">runner {shortDevice(c.deviceId)}</span>
          <span className="font-bold tabular-nums">
            {c.running}/{RUNNER_CAP} in-flight
          </span>
          {c.queued > 0 && <span className="text-outline">· {c.queued} queued</span>}
        </li>
      ))}
    </ul>
  );
}

function JobSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <h3 className="text-[10px] font-bold uppercase tracking-[0.2em] text-outline">{title}</h3>
      <ul className="divide-y divide-outline-variant/20 rounded-sm border border-outline-variant/20 bg-surface-container-low">
        {children}
      </ul>
    </div>
  );
}

interface JobRowProps {
  job: Job;
  runKindById: Map<string, PipelineRunKind>;
  slug: string;
  timeRef: Date | string | null;
  stuck?: boolean;
  waiting?: boolean;
}

function JobRow({ job, runKindById, slug, timeRef, stuck, waiting }: JobRowProps) {
  const kind = runKindById.get(job.pipelineRunId) ?? 'system';
  const label = job.issueId ? (
    <Link
      href={`/projects/${slug}/issues/${job.issueId}`}
      className="truncate text-xs text-primary hover:underline"
    >
      issue
    </Link>
  ) : (
    <span className="truncate text-xs text-on-surface-variant">{kind}</span>
  );

  return (
    <li className="flex items-center gap-2 px-3 py-1.5 text-xs">
      {waiting ? (
        <Clock className="h-3.5 w-3.5 shrink-0 text-outline" />
      ) : job.status === 'running' ? (
        <AgentRunningDot />
      ) : (
        <Clock className="h-3.5 w-3.5 shrink-0 animate-pulse text-outline" />
      )}
      <span className="shrink-0 font-mono text-[10px] uppercase tracking-wider text-on-surface-variant">
        {job.type}
      </span>
      <span className="min-w-0 flex-1">{label}</span>
      {stuck && (
        <span className="inline-flex shrink-0 items-center gap-1 rounded-sm bg-error-container/20 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-widest text-error">
          <AlertTriangle className="h-3 w-3" />
          stuck
        </span>
      )}
      <span className="shrink-0 font-mono tabular-nums text-[10px] text-outline">
        {formatElapsed(timeRef)}
      </span>
    </li>
  );
}

export default PipelineActivityPanel;
