'use client';

import { useMemo, useRef, useState } from 'react';
import { PIPELINE_STAGES, type PipelineStage } from '@/features/issue/api/issue-api';
import { useRunPipelineStep } from '@/features/issue/hooks/use-issues';
import { useEnrichIssue } from '@/features/issue/hooks/use-enrich';
import { usePipelineRegistry } from '@/features/pipeline/use-pipeline-registry';
import { ApiError } from '@/lib/api/client';

interface Props {
  issueId: string;
  status: string;
}

const DESTRUCTIVE_STAGES = new Set<PipelineStage>(['release']);

const STATUS_TO_LABEL: Record<string, string> = {
  open: 'Triage',
  confirmed: 'Clarify',
  waiting: 'Plan Implementation',
  approved: 'Start Coding',
  in_progress: 'Continue Coding',
  developed: 'Run Review',
  testing: 'Run Tests',
  tested: 'Release',
  reopen: 'Fix Issue',
  needs_info: 'Clarify',
  pipeline_failed: 'Retry',
};

const TERMINAL_STATUSES = new Set(['released', 'closed', 'staging', 'pass']);

const RATE_LIMIT_MS = 2000;

export function IssuePipelineActions({ issueId, status }: Props) {
  const [open, setOpen] = useState(false);
  const [feedback, setFeedback] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);
  const lastFireRef = useRef<number>(0);
  const runMutation = useRunPipelineStep();
  const enrichMutation = useEnrichIssue();
  const { data: registry } = usePipelineRegistry();

  // Stage → skill name labels are derived from the pipeline registry
  // (single SSOT). Manual-only types (clarify) and any future stage not
  // in PIPELINE_STEPS fall back to the `forge-<stage>` convention so the
  // UI never shows a blank label.
  const stageLabel = useMemo<Record<PipelineStage, string>>(() => {
    const out = {} as Record<PipelineStage, string>;
    for (const s of PIPELINE_STAGES) {
      const step = registry?.steps.find((entry) => entry.jobType === s);
      out[s as PipelineStage] = step?.skillName ?? `forge-${s}`;
    }
    return out;
  }, [registry]);

  function flash(tone: 'ok' | 'err', text: string) {
    setFeedback({ tone, text });
    setTimeout(() => setFeedback((cur) => (cur?.text === text ? null : cur)), 4000);
  }

  function rateLimited(): boolean {
    const now = Date.now();
    if (now - lastFireRef.current < RATE_LIMIT_MS) {
      flash('err', 'Wait 2s before clicking again');
      return true;
    }
    lastFireRef.current = now;
    return false;
  }

  async function fire(stage?: PipelineStage) {
    setOpen(false);
    if (rateLimited()) return;
    if (stage && DESTRUCTIVE_STAGES.has(stage)) {
      const ok = window.confirm(
        `Fire ${stageLabel[stage]} for this issue? This is a destructive stage (release / production deploy).`,
      );
      if (!ok) return;
    }
    try {
      const res = await runMutation.mutateAsync(stage ? { id: issueId, stage } : { id: issueId });
      flash('ok', `Job queued, ID ${res.jobId.slice(0, 8)}`);
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.code === 'JOB_ALREADY_ACTIVE') {
          const details = (err.details as { jobId?: string } | null) ?? null;
          const jobId = details?.jobId ? ` (job ${details.jobId.slice(0, 8)})` : '';
          flash('err', `Pipeline already running${jobId}`);
          return;
        }
        if (err.code === 'BAD_REQUEST') {
          flash('err', 'Pick a stage manually');
          setOpen(true);
          return;
        }
        flash('err', err.message);
        return;
      }
      const msg = err instanceof Error ? err.message : 'Failed to queue job';
      flash('err', msg);
    }
  }

  async function fireEnrich() {
    if (rateLimited()) return;
    try {
      await enrichMutation.mutateAsync(issueId);
      flash('ok', 'Enrichment queued');
    } catch (err) {
      if (err instanceof ApiError && err.code === 'ENRICH_ALREADY_QUEUED') {
        flash('err', 'Enrichment queued, please wait');
        return;
      }
      const msg = err instanceof Error ? err.message : 'Failed to queue enrich';
      flash('err', msg);
    }
  }

  const busy = runMutation.isPending || enrichMutation.isPending;
  const isTerminal = TERMINAL_STATUSES.has(status);
  const primaryLabel = STATUS_TO_LABEL[status] ?? 'Run pipeline';

  return (
    <div className="relative flex flex-wrap items-center gap-2">
      <button
        type="button"
        disabled={busy || isTerminal}
        onClick={() => fire(undefined)}
        className="rounded-sm border border-outline bg-surface-container px-3 py-1.5 text-xs font-mono uppercase tracking-widest text-on-surface hover:bg-surface-container-high disabled:opacity-50 disabled:cursor-not-allowed"
        title={isTerminal ? 'No further pipeline stage' : `Run pipeline for current status: ${status}`}
      >
        {busy ? 'Queuing…' : primaryLabel}
      </button>
      <div className="relative">
        <button
          type="button"
          disabled={busy || isTerminal}
          onClick={() => setOpen((v) => !v)}
          className="rounded-sm border border-outline bg-surface-container px-2 py-1.5 text-xs font-mono text-on-surface hover:bg-surface-container-high disabled:opacity-50"
          title="Force re-run a specific stage"
          aria-haspopup="menu"
          aria-expanded={open}
        >
          ▾
        </button>
        {open && (
          <div
            role="menu"
            className="absolute right-0 z-20 mt-1 w-48 rounded-sm border border-outline bg-surface-container shadow-lg"
          >
            <ul className="py-1">
              {PIPELINE_STAGES.map((s) => (
                <li key={s}>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => fire(s)}
                    className="flex w-full items-center justify-between px-3 py-1.5 text-left text-xs font-mono text-on-surface hover:bg-surface-container-high"
                  >
                    <span>{stageLabel[s]}</span>
                    {DESTRUCTIVE_STAGES.has(s) && (
                      <span className="text-[10px] uppercase tracking-widest text-error">!</span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
      <button
        type="button"
        disabled={busy}
        onClick={fireEnrich}
        className="rounded-sm border border-outline bg-surface-container px-3 py-1.5 text-xs font-mono uppercase tracking-widest text-on-surface-variant hover:bg-surface-container-high disabled:opacity-50"
        title="Re-run AI enrichment"
      >
        Enrich
      </button>
      {feedback && (
        <span
          className={`text-[10px] font-mono uppercase tracking-widest ${
            feedback.tone === 'ok' ? 'text-on-surface-variant' : 'text-error'
          }`}
        >
          {feedback.text}
        </span>
      )}
    </div>
  );
}
