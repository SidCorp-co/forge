'use client';

import { AlertTriangle } from 'lucide-react';
import { Select, Switch } from '@/components/ui';
import { RUNNER_CAPABILITIES, runnerSupports } from '@/features/pipeline/runner-capabilities';
import { STEP_REGISTRY, type StepToggleKey } from '../step-registry';
import type { StepFormValue } from '../hooks/use-pipeline-config';

interface Props {
  steps: Record<StepToggleKey, StepFormValue>;
  onChange: (key: StepToggleKey, value: StepFormValue) => void;
  availableRunners: string[];
  masterEnabled: boolean;
}

export function StepToggleList({ steps, onChange, availableRunners, masterEnabled }: Props) {
  const supportsRunnerOverride = availableRunners.length > 1;

  return (
    <div className="bg-surface-container-low border border-outline-variant/30 p-6 space-y-4">
      <div className="space-y-1">
        <h3 className="text-sm font-semibold text-on-surface">Pipeline steps</h3>
        <p className="text-xs text-on-surface-variant">
          Toggle each automation step independently. Disabled steps still allow manual triggers
          from the issue page.
        </p>
      </div>

      <ul className="space-y-2">
        {STEP_REGISTRY.map((def) => {
          const v = steps[def.toggleKey];
          const rowDisabled = !masterEnabled;
          return (
            <li
              key={def.toggleKey}
              className="border border-outline-variant/20 p-3 space-y-2 bg-surface"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1 space-y-0.5">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-medium text-on-surface">{def.label}</span>
                    <span className="rounded bg-surface-container-high px-1.5 py-0.5 text-[10px] font-mono text-on-surface-variant">
                      {def.statusTransition}
                    </span>
                  </div>
                  <p className="text-xs text-on-surface-variant leading-snug">{def.description}</p>
                </div>
                <Switch
                  id={`step-${def.toggleKey}`}
                  checked={v.enabled}
                  disabled={rowDisabled}
                  onChange={(e) =>
                    onChange(def.toggleKey, { ...v, enabled: e.currentTarget.checked })
                  }
                />
              </div>

              {v.enabled && !rowDisabled && !runnerSupports(v.runner, def.jobType) && (
                <div className="flex items-start gap-2 rounded-sm border border-amber-500/30 bg-amber-500/10 p-2 text-[11px] text-amber-300">
                  <AlertTriangle className="h-3 w-3 shrink-0 mt-0.5" />
                  <p>
                    The {v.runner} runner doesn't service '{def.jobType}' jobs (it supports{' '}
                    {RUNNER_CAPABILITIES[v.runner as keyof typeof RUNNER_CAPABILITIES]?.join(', ') ?? 'a different set'}).
                    Enabling this toggle on the {v.runner} runner will produce visible-but-harmless
                    'unsupported job type' failures every time an issue passes through '
                    {def.statusTransition.split(' ')[0]}'. Either switch this step's runner to one
                    that supports it, or disable the toggle.
                  </p>
                </div>
              )}

              {supportsRunnerOverride && v.enabled && !rowDisabled && (
                <div className="flex flex-wrap items-center gap-3 pt-1.5 border-t border-outline-variant/15">
                  <label className="flex items-center gap-2">
                    <span className="text-[10px] uppercase tracking-widest text-on-surface-variant">
                      Runner
                    </span>
                    <Select
                      value={v.runner ?? ''}
                      onChange={(e) =>
                        onChange(def.toggleKey, {
                          ...v,
                          runner: e.target.value || undefined,
                        })
                      }
                      className="h-8 text-xs"
                    >
                      <option value="">Project default</option>
                      {availableRunners.map((r) => (
                        <option key={r} value={r}>
                          {r}
                        </option>
                      ))}
                    </Select>
                  </label>
                  {v.runner && (
                    <label className="flex items-center gap-2 flex-1 min-w-[180px]">
                      <span className="text-[10px] uppercase tracking-widest text-on-surface-variant">
                        Model
                      </span>
                      <input
                        type="text"
                        value={v.model ?? ''}
                        onChange={(e) =>
                          onChange(def.toggleKey, {
                            ...v,
                            model: e.target.value || undefined,
                          })
                        }
                        placeholder="default"
                        className="flex-1 bg-transparent border-0 border-b border-outline-variant/30 py-1 text-xs text-on-surface placeholder:text-on-surface-variant/50 focus:outline-none focus:border-b-primary"
                      />
                    </label>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>

      <p className="text-[11px] text-on-surface-variant pt-1">
        <span className="font-medium">Note:</span> The <code className="font-mono">clarified</code>{' '}
        status is human-gated and is not configurable.
      </p>
    </div>
  );
}
