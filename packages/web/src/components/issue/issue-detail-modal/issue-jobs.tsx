'use client';

import { useMemo, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  CheckCircle2,
  Clock,
  Loader2,
  MinusCircle,
  XCircle,
  type LucideIcon,
} from 'lucide-react';
import type { Job } from '@forge/contracts';
import { useJobs } from '@/features/job/hooks/use-jobs';
import { PromptInspectorDrawer } from '@/features/job/components/PromptInspectorDrawer';
import { classifyJobFailure, type JobFailureKind } from '@/features/pipeline/job-failure';
import { Skeleton } from '@/components/ui';

interface Props {
  issueId: string;
  projectId: string;
}

interface JobChain {
  head: Job;
  retries: Job[];
}

const queuedAtMs = (job: Job): number => new Date(job.queuedAt as unknown as string).getTime();
const queuedAtIso = (job: Job): string => job.queuedAt as unknown as string;

function groupRetryChains(rows: Job[]): JobChain[] {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const chainMap = new Map<string, JobChain>();

  for (const row of rows) {
    let head = row;
    const visited = new Set<string>([row.id]);
    while (head.retryOf) {
      const parent = byId.get(head.retryOf);
      if (!parent || visited.has(parent.id)) break;
      visited.add(parent.id);
      head = parent;
    }
    let chain = chainMap.get(head.id);
    if (!chain) {
      chain = { head, retries: [] };
      chainMap.set(head.id, chain);
    }
    if (row.id !== head.id) chain.retries.push(row);
  }

  for (const chain of chainMap.values()) {
    chain.retries.sort((a, b) => queuedAtMs(a) - queuedAtMs(b));
  }

  return [...chainMap.values()].sort((a, b) => queuedAtMs(b.head) - queuedAtMs(a.head));
}

export function IssueJobs({ issueId, projectId }: Props) {
  const jobsQuery = useJobs({ projectId, issueId, limit: 50 });
  const [inspectJobId, setInspectJobId] = useState<string | null>(null);
  const chains = useMemo(
    () => groupRetryChains(jobsQuery.data?.items ?? []),
    [jobsQuery.data?.items],
  );

  return (
    <section className="rounded-sm border border-outline-variant/20 bg-surface">
      <div className="border-b border-outline-variant/20 bg-surface-container-low px-4 py-2">
        <h3 className="text-[10px] font-bold uppercase tracking-[0.2em] text-on-surface-variant">
          Jobs
        </h3>
      </div>
      <div className="p-3 text-sm">
        {jobsQuery.isLoading ? (
          <Skeleton className="h-12 w-full" />
        ) : jobsQuery.isError ? (
          <span className="text-outline">Failed to load jobs</span>
        ) : chains.length === 0 ? (
          <span className="text-outline">No jobs yet</span>
        ) : (
          <ul className="space-y-1">
            {chains.map((chain) => (
              <JobChainRow
                key={chain.head.id}
                chain={chain}
                onInspect={(id) => setInspectJobId(id)}
              />
            ))}
          </ul>
        )}
      </div>
      {inspectJobId && (
        <PromptInspectorDrawer
          jobId={inspectJobId}
          onClose={() => setInspectJobId(null)}
        />
      )}
    </section>
  );
}

interface JobChainRowProps {
  chain: JobChain;
  onInspect: (jobId: string) => void;
}

function JobChainRow({ chain, onInspect }: JobChainRowProps) {
  const [expanded, setExpanded] = useState(false);
  const lastAttempt = chain.retries[chain.retries.length - 1] ?? chain.head;
  const hasRetries = chain.retries.length > 0;
  const allAttempts = [chain.head, ...chain.retries];
  const failedCount = allAttempts.filter((j) => j.status === 'failed').length;
  const ChevronIcon = expanded ? ChevronDown : ChevronRight;
  const showInspect = lastAttempt.status === 'done';

  return (
    <li className="rounded-sm border border-outline-variant/15 bg-surface-container-low">
      <div className="flex w-full items-center">
        <button
          type="button"
          onClick={() => hasRetries && setExpanded((v) => !v)}
          className={`flex flex-1 items-center gap-2 px-3 py-2 text-left ${
            hasRetries ? 'cursor-pointer hover:bg-surface-container' : 'cursor-default'
          }`}
          disabled={!hasRetries}
        >
          <span className="w-3 shrink-0 text-on-surface-variant">
            {hasRetries && <ChevronIcon className="h-3 w-3" />}
          </span>
          <JobStatusIcon job={lastAttempt} />
          <span className="rounded bg-surface-container-high px-1.5 py-0.5 text-[10px] font-mono uppercase tracking-widest text-on-surface-variant">
            {lastAttempt.type}
          </span>
          <span className="flex-1 truncate text-xs text-on-surface">
            {hasRetries ? (
              <>
                <span className="text-on-surface-variant">failed x {failedCount} (last attempt: </span>
                <JobStatusLabel job={lastAttempt} />
                <span className="text-on-surface-variant">)</span>
              </>
            ) : (
              <JobStatusLabel job={lastAttempt} />
            )}
          </span>
          <time
            className="shrink-0 text-[10px] uppercase tracking-widest text-outline"
            dateTime={queuedAtIso(lastAttempt)}
          >
            {new Date(queuedAtIso(lastAttempt)).toLocaleString()}
          </time>
        </button>
        {showInspect && (
          <button
            type="button"
            onClick={() => onInspect(lastAttempt.id)}
            className="mr-2 shrink-0 rounded-sm border border-outline-variant/30 px-2 py-0.5 text-[10px] uppercase tracking-widest text-on-surface-variant hover:bg-surface-container"
          >
            Inspect
          </button>
        )}
      </div>
      {hasRetries && expanded && (
        <ul className="border-t border-outline-variant/15 bg-surface px-3 py-1.5">
          {allAttempts.map((attempt, idx) => (
            <li
              key={attempt.id}
              className="flex items-center gap-2 py-1 text-xs text-on-surface-variant"
            >
              <span className="w-3 shrink-0 text-[10px] font-mono text-outline">#{idx + 1}</span>
              <JobStatusIcon job={attempt} />
              <span className="flex-1 truncate">
                <JobStatusLabel job={attempt} />
              </span>
              <time
                className="shrink-0 text-[10px] uppercase tracking-widest text-outline"
                dateTime={queuedAtIso(attempt)}
              >
                {new Date(queuedAtIso(attempt)).toLocaleString()}
              </time>
              {attempt.status === 'done' && (
                <button
                  type="button"
                  onClick={() => onInspect(attempt.id)}
                  className="shrink-0 rounded-sm border border-outline-variant/30 px-2 py-0.5 text-[10px] uppercase tracking-widest text-on-surface-variant hover:bg-surface-container"
                >
                  Inspect
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

const FAILURE_ICONS: Record<JobFailureKind, { Icon: LucideIcon; color: string }> = {
  'runner-skipped': { Icon: MinusCircle, color: 'text-on-surface-variant' },
  'watchdog-stalled': { Icon: Clock, color: 'text-amber-400' },
  'agent-errored': { Icon: XCircle, color: 'text-error' },
};

function IconBadge({
  Icon,
  colorClass,
  title,
  label,
}: {
  Icon: LucideIcon;
  colorClass: string;
  title?: string;
  label: string;
}) {
  return (
    <span title={title} aria-label={label} className="inline-flex">
      <Icon className={`h-3.5 w-3.5 shrink-0 ${colorClass}`} />
    </span>
  );
}

function JobStatusIcon({ job }: { job: Job }) {
  if (job.status === 'failed') {
    const cls = classifyJobFailure(job.error, job.failureKind);
    const { Icon, color } = FAILURE_ICONS[cls.kind];
    return <IconBadge Icon={Icon} colorClass={color} title={cls.tooltip} label={cls.label} />;
  }
  if (job.status === 'done') {
    return <IconBadge Icon={CheckCircle2} colorClass="text-emerald-400" label="done" />;
  }
  if (job.status === 'running' || job.status === 'dispatched') {
    return (
      <IconBadge Icon={Loader2} colorClass="animate-spin text-primary" label={job.status} />
    );
  }
  return <IconBadge Icon={Clock} colorClass="text-on-surface-variant" label={job.status} />;
}

function JobStatusLabel({ job }: { job: Job }) {
  if (job.status === 'failed') {
    const cls = classifyJobFailure(job.error, job.failureKind);
    return <span title={cls.tooltip}>{cls.label}</span>;
  }
  return <span className="capitalize">{job.status}</span>;
}
