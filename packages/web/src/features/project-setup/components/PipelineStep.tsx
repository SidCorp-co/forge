'use client';

import { useEffect, useState } from 'react';
import { usePipelineConfig } from '@/features/pipeline/config/hooks/use-pipeline-config';
import type { StepToggleKey } from '@/features/pipeline/config/step-registry';

interface Props {
  projectId: string;
  onSaved: () => void;
}

const DEFAULT_STEPS: Record<StepToggleKey, boolean> = {
  autoTriage: true,
  autoPlan: true,
  autoCode: true,
  autoReview: true,
  autoTest: true,
  autoFix: true,
  autoRelease: false,
};

const STEP_LABELS: Record<StepToggleKey, string> = {
  autoTriage: 'Triage',
  autoPlan: 'Plan',
  autoCode: 'Code',
  autoReview: 'Review',
  autoTest: 'Test',
  autoFix: 'Fix',
  autoRelease: 'Release',
};

export function PipelineStep({ projectId, onSaved }: Props) {
  const cfg = usePipelineConfig(projectId);
  const [didSeed, setDidSeed] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Seed defaults when the project has no pipeline config yet (all steps off
  // by default in FALLBACK_DEFAULTS). Only fires once per mount.
  useEffect(() => {
    if (cfg.isLoading || didSeed) return;
    if (!cfg.state.enabled) {
      cfg.setField('enabled', true);
      for (const [k, v] of Object.entries(DEFAULT_STEPS) as Array<[StepToggleKey, boolean]>) {
        cfg.setStep(k, { enabled: v });
      }
    }
    setDidSeed(true);
  }, [cfg, didSeed]);

  const onSave = async () => {
    setError(null);
    try {
      await cfg.save();
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save pipeline config.');
    }
  };

  if (cfg.flagDisabled) {
    return (
      <p className="text-sm text-warning">
        The pipeline feature is disabled on this server. Skip this step.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      <label className="flex items-center gap-3 cursor-pointer">
        <input
          type="checkbox"
          checked={cfg.state.enabled}
          onChange={(e) => cfg.setField('enabled', e.target.checked)}
          className="accent-primary h-4 w-4"
        />
        <span className="text-sm font-medium text-on-surface">Enable the pipeline</span>
      </label>

      <div className="space-y-2 pl-7">
        <p className="text-[11px] text-outline">
          Toggle the agent steps you want to run automatically.
        </p>
        {(Object.keys(STEP_LABELS) as StepToggleKey[]).map((key) => (
          <label key={key} className="flex items-center gap-3 text-sm text-on-surface-variant cursor-pointer">
            <input
              type="checkbox"
              checked={cfg.state.steps[key]?.enabled ?? false}
              onChange={(e) =>
                cfg.setStep(key, { ...(cfg.state.steps[key] ?? {}), enabled: e.target.checked })
              }
              disabled={!cfg.state.enabled}
              className="accent-primary h-4 w-4"
            />
            {STEP_LABELS[key]}
          </label>
        ))}
      </div>

      {error && (
        <p className="text-xs text-error" role="alert">
          {error}
        </p>
      )}

      <div className="flex justify-end">
        <button
          type="button"
          onClick={() => void onSave()}
          disabled={cfg.isSaving || !cfg.isDirty}
          className="bg-primary text-on-primary px-4 py-2 text-sm rounded-sm disabled:opacity-50"
        >
          {cfg.isSaving ? 'Saving…' : 'Save pipeline'}
        </button>
      </div>
    </div>
  );
}
