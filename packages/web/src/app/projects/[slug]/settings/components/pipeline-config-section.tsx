'use client';

import { UnimplementedBanner } from '@/components/common/unimplemented-banner';
import { Spinner } from '@/components/ui';
import { ConcurrencyCard } from '@/features/pipeline/config/components/concurrency-card';
import { PipelineMasterToggle } from '@/features/pipeline/config/components/pipeline-master-toggle';
import { RecoveryPolicyCard } from '@/features/pipeline/config/components/recovery-policy-card';
import { RunnerDefaultsCard } from '@/features/pipeline/config/components/runner-defaults-card';
import { StepToggleList } from '@/features/pipeline/config/components/step-toggle-list';
import { usePipelineConfig } from '@/features/pipeline/config/hooks/use-pipeline-config';
import { useFocusOnMount } from '../hooks/use-focus-on-mount';

interface Props {
  projectId: string;
}

/**
 * Available runner adapter types known to the system. Mirrors
 * `runnerTypes` in packages/core/src/db/schema.ts. When a new adapter type
 * lands in core, add it here — the dropdowns will pick it up automatically.
 */
const KNOWN_RUNNER_TYPES = ['claude-code', 'antigravity'];

// Keep in sync with DEFAULT_MAX_CONCURRENT_ISSUES in
// packages/core/src/jobs/dispatch-gates.ts — the L3 dispatch gate falls back
// to this value when no project override is stored.
const DEFAULT_MAX_CONCURRENT_ISSUES = 3;

export function PipelineConfigSection({ projectId }: Props) {
  const cfg = usePipelineConfig(projectId, KNOWN_RUNNER_TYPES);
  useFocusOnMount();

  if (cfg.flagDisabled) {
    return (
      <UnimplementedBanner
        feature="Pipeline configuration"
        hint="This feature is gated behind the pipelineControl feature flag. Set FEATURE_PIPELINE_CONTROL=true on the core deployment to enable."
      />
    );
  }

  if (cfg.isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Spinner />
      </div>
    );
  }

  return (
    <section className="space-y-6">
      <div className="flex justify-between items-end border-b border-outline-variant/10 pb-2">
        <h2 className="text-[10px] uppercase tracking-[0.2em] text-on-surface-variant font-bold">
          03. Pipeline Control
        </h2>
        <span className="text-[9px] font-mono text-on-surface-variant">PLC_SYS_03</span>
      </div>

      <div data-config-health-target="pipeline.enabled">
        <PipelineMasterToggle
          enabled={cfg.state.enabled}
          onChange={(v) => cfg.setField('enabled', v)}
          disabled={cfg.isSaving}
        />
      </div>

      <StepToggleList
        steps={cfg.state.steps}
        onChange={cfg.setStep}
        availableRunners={cfg.availableRunners}
        masterEnabled={cfg.state.enabled}
      />

      <RecoveryPolicyCard
        maxAttempts={cfg.state.recoveryMaxAttempts}
        windowHours={cfg.state.recoveryWindowHours}
        byKind={cfg.state.recoveryByKind}
        onMaxAttemptsChange={(n) => cfg.setField('recoveryMaxAttempts', n)}
        onWindowHoursChange={(n) => cfg.setField('recoveryWindowHours', n)}
        onByKindChange={cfg.setRecoveryByKind}
      />

      <ConcurrencyCard
        value={cfg.state.maxConcurrentIssues}
        defaultValue={DEFAULT_MAX_CONCURRENT_ISSUES}
        onChange={(v) => cfg.setField('maxConcurrentIssues', v)}
      />

      <RunnerDefaultsCard
        chain={cfg.state.runnerFallback}
        availableTypes={cfg.availableRunners}
        onChange={(v) => cfg.setField('runnerFallback', v)}
      />

      {cfg.isError && !cfg.flagDisabled && (
        <p className="text-xs text-error">
          {cfg.error instanceof Error ? cfg.error.message : 'Failed to save pipeline config.'}
        </p>
      )}

      <div className="flex items-center gap-3 pt-4 border-t border-outline-variant/10">
        <button
          type="button"
          onClick={() => void cfg.save()}
          disabled={cfg.isSaving || !cfg.isDirty}
          className="bg-gradient-to-br from-primary to-tertiary text-on-primary px-6 py-2 text-[10px] font-black uppercase tracking-[0.15em] rounded-sm hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {cfg.isSaving ? 'Saving…' : 'Save Pipeline Config'}
        </button>
        {cfg.isDirty && (
          <button
            type="button"
            onClick={cfg.reset}
            disabled={cfg.isSaving}
            className="text-[10px] font-medium uppercase tracking-[0.15em] text-on-surface-variant hover:text-on-surface disabled:opacity-50"
          >
            Discard
          </button>
        )}
      </div>
    </section>
  );
}
