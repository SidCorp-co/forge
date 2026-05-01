'use client';

import { useState } from 'react';
import { PIPELINE_STAGES, type PipelineStage } from '@/features/issue/api/issue-api';
import { useRunPipelineStep } from '@/features/issue/hooks/use-issues';
import { ApiError } from '@/lib/api/client';

interface Props {
  issueId: string;
  status: string;
}

// Stages that should require explicit confirmation before firing — they
// merge code, ship to staging, or release to production.
const DESTRUCTIVE_STAGES = new Set<PipelineStage>(['release']);

const STAGE_LABEL: Record<PipelineStage, string> = {
  triage: 'forge-triage',
  plan: 'forge-plan',
  code: 'forge-code',
  review: 'forge-review',
  test: 'forge-test',
  fix: 'forge-fix',
  release: 'forge-release',
  clarify: 'forge-clarify',
};

export function IssuePipelineActions({ issueId, status }: Props) {
  const [open, setOpen] = useState(false);
  const [feedback, setFeedback] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);
  const mutation = useRunPipelineStep();

  function flash(tone: 'ok' | 'err', text: string) {
    setFeedback({ tone, text });
    setTimeout(() => setFeedback((cur) => (cur?.text === text ? null : cur)), 4000);
  }

  async function fire(stage?: PipelineStage) {
    setOpen(false);
    if (stage && DESTRUCTIVE_STAGES.has(stage)) {
      const ok = window.confirm(
        `Fire ${STAGE_LABEL[stage]} for this issue? This is a destructive stage (release / production deploy).`,
      );
      if (!ok) return;
    }
    try {
      const res = await mutation.mutateAsync(stage ? { id: issueId, stage } : { id: issueId });
      flash('ok', `Queued forge-${res.stage}`);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'JOB_ALREADY_ACTIVE') {
        flash('err', 'Job already running, cancel first');
        return;
      }
      const msg = err instanceof Error ? err.message : 'Failed to queue job';
      flash('err', msg);
    }
  }

  const busy = mutation.isPending;

  return (
    <div className="relative flex items-center gap-2">
      <button
        type="button"
        disabled={busy}
        onClick={() => fire(undefined)}
        className="rounded-md border border-outline bg-surface-container px-3 py-1.5 text-xs font-mono uppercase tracking-widest text-on-surface hover:bg-surface-container-high disabled:opacity-50 disabled:cursor-not-allowed"
        title={`Run pipeline for current status: ${status}`}
      >
        {busy ? 'Queuing…' : 'Run pipeline'}
      </button>
      <div className="relative">
        <button
          type="button"
          disabled={busy}
          onClick={() => setOpen((v) => !v)}
          className="rounded-md border border-outline bg-surface-container px-2 py-1.5 text-xs font-mono text-on-surface hover:bg-surface-container-high disabled:opacity-50"
          title="Force re-run a specific stage"
          aria-haspopup="menu"
          aria-expanded={open}
        >
          ▾
        </button>
        {open && (
          <div
            role="menu"
            className="absolute right-0 z-20 mt-1 w-48 rounded-md border border-outline bg-surface-container shadow-lg"
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
                    <span>{STAGE_LABEL[s]}</span>
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
