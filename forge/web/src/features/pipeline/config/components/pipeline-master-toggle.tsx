'use client';

import { Switch } from '@/components/ui';

interface Props {
  enabled: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}

export function PipelineMasterToggle({ enabled, onChange, disabled }: Props) {
  return (
    <div className="bg-surface-container-low border border-outline-variant/30 p-6">
      <div className="flex items-start justify-between gap-6">
        <div className="min-w-0 flex-1 space-y-1.5">
          <h3 className="text-sm font-semibold text-on-surface">Auto-progression</h3>
          <p className="text-xs text-on-surface-variant leading-relaxed">
            {enabled
              ? 'On every status transition, the pipeline orchestrator enqueues a job for the configured runner. Disable individual steps below to opt out per-stage.'
              : 'When enabled, the orchestrator will enqueue jobs automatically on status transitions according to the per-step toggles below.'}
          </p>
        </div>
        <Switch
          id="pipeline-master-toggle"
          checked={enabled}
          onChange={(e) => onChange(e.currentTarget.checked)}
          disabled={disabled}
        />
      </div>
    </div>
  );
}
