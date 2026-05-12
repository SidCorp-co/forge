'use client';

import { useMemo } from 'react';
import { Button, Skeleton, Timeline, type TimelineStep } from '@/components/ui';
import {
  useCancelPipelineRun,
  usePausePipelineRun,
  useProjectPipelineRuns,
  useResumePipelineRun,
  usePipelineRun,
} from '@/features/pipeline-run/hooks/use-pipeline-runs';
import { isTerminalRunStatus, type PipelineRun } from '@/features/pipeline-run/types';
import { formatApiError } from '@/lib/api/error';

interface IssuePipelineRunPanelProps {
  issueId: string;
  projectId: string;
  onSelectSession: (sessionId: string) => void;
}

const moneyFmt = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 4,
});

const numFmt = new Intl.NumberFormat('en-US');

const STATUS_PILL: Record<PipelineRun['status'], string> = {
  running: 'bg-primary/15 text-primary border-primary/30',
  paused: 'bg-amber-500/15 text-amber-400 border-amber-500/40',
  completed: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/40',
  failed: 'bg-error/15 text-error border-error/40',
  cancelled: 'bg-surface-container border-outline-variant/30 text-outline-variant',
};

export function IssuePipelineRunPanel({
  issueId,
  projectId,
  onSelectSession,
}: IssuePipelineRunPanelProps) {
  const listQuery = useProjectPipelineRuns({ projectId, issueId, limit: 1 });
  const latestRunId = listQuery.data?.items[0]?.id;
  const detailQuery = usePipelineRun(latestRunId);

  const pauseMut = usePausePipelineRun();
  const resumeMut = useResumePipelineRun();
  const cancelMut = useCancelPipelineRun();

  const isLoading = listQuery.isLoading || (!!latestRunId && detailQuery.isLoading);
  const error = listQuery.error ?? detailQuery.error;
  const run = detailQuery.data;

  const steps: TimelineStep[] = useMemo(() => {
    if (!run) return [];
    return run.steps.map((s) => ({
      key: s.jobType,
      label: s.jobType,
      status: s.status,
      startedAt: s.startedAt,
      finishedAt: s.finishedAt,
      durationMs: s.durationMs,
      clickable: s.agentSessionId !== null && s.status !== 'pending',
    }));
  }, [run]);

  function handleStepClick(key: string) {
    const step = run?.steps.find((s) => s.jobType === key);
    if (step?.agentSessionId) onSelectSession(step.agentSessionId);
  }

  function handleCancel() {
    if (!run) return;
    const ok = window.confirm(
      'Cancel this pipeline run? Queued steps will be cancelled and the active agent session will be aborted.',
    );
    if (!ok) return;
    cancelMut.mutate(run.id);
  }

  return (
    <section className="rounded-sm border border-outline-variant/20 bg-surface">
      <div className="flex items-center justify-between border-b border-outline-variant/20 bg-surface-container-low px-4 py-2">
        <h3 className="text-[10px] font-bold uppercase tracking-[0.2em] text-on-surface-variant">
          Pipeline run
        </h3>
        {run && (
          <span
            className={`inline-flex items-center rounded-sm border px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest ${STATUS_PILL[run.status]}`}
          >
            {run.status}
          </span>
        )}
      </div>
      <div className="space-y-3 p-4 text-sm">
        {isLoading ? (
          <Skeleton className="h-12 w-full" />
        ) : error ? (
          <p className="text-[10px] uppercase tracking-widest text-error">
            {formatApiError(error)}
          </p>
        ) : !run ? (
          <p className="text-[11px] text-outline">
            No pipeline run yet. Trigger a pipeline stage to start one.
          </p>
        ) : (
          <>
            <Timeline
              steps={steps}
              currentKey={run.currentStep ?? undefined}
              onStepClick={handleStepClick}
            />

            <CostRow run={run} />

            <div className="flex flex-wrap items-center gap-2">
              {run.status === 'running' && (
                <Button
                  size="xs"
                  variant="secondary"
                  disabled={pauseMut.isPending}
                  onClick={() => pauseMut.mutate(run.id)}
                >
                  {pauseMut.isPending ? 'Pausing…' : 'Pause'}
                </Button>
              )}
              {run.status === 'paused' && (
                <Button
                  size="xs"
                  disabled={resumeMut.isPending}
                  onClick={() => resumeMut.mutate(run.id)}
                >
                  {resumeMut.isPending ? 'Resuming…' : 'Resume'}
                </Button>
              )}
              {!isTerminalRunStatus(run.status) && (
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={cancelMut.isPending}
                  onClick={handleCancel}
                >
                  {cancelMut.isPending ? 'Cancelling…' : 'Cancel run'}
                </Button>
              )}
            </div>

            {(pauseMut.error || resumeMut.error || cancelMut.error) && (
              <p className="text-[10px] uppercase tracking-widest text-error">
                {formatApiError(
                  pauseMut.error ?? resumeMut.error ?? cancelMut.error,
                )}
              </p>
            )}
          </>
        )}
      </div>
    </section>
  );
}

function CostRow({ run }: { run: PipelineRun }) {
  const totalTokens =
    run.cost.inputTokens +
    run.cost.outputTokens +
    run.cost.cacheReadTokens +
    run.cost.cacheCreationTokens;
  return (
    <dl className="flex flex-wrap gap-x-6 gap-y-1 text-xs">
      <Field label="Cost">
        <span className="font-mono text-on-surface">
          {moneyFmt.format(run.cost.estimatedCost)}
        </span>
      </Field>
      <Field label="Tokens">
        <span className="font-mono text-on-surface">{numFmt.format(totalTokens)}</span>
      </Field>
      <Field label="Sessions">
        <span className="font-mono text-on-surface">
          {numFmt.format(run.cost.sampleCount)}
        </span>
      </Field>
      {run.currentStep && (
        <Field label="Current step">
          <span className="font-mono text-on-surface">{run.currentStep}</span>
        </Field>
      )}
    </dl>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-1.5">
      <dt className="text-[10px] font-bold uppercase tracking-widest text-outline">
        {label}
      </dt>
      <dd>{children}</dd>
    </div>
  );
}

export default IssuePipelineRunPanel;
