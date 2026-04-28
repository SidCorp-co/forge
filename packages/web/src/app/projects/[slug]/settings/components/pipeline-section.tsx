'use client';

import { useState } from 'react';
import { Plus, Trash2, ChevronDown, ChevronUp } from 'lucide-react';
import { getPokemonForStep } from '@/lib/constants/pipeline-pokemon';
import {
  STEPS, RUNNERS, ANTIGRAVITY_MODELS, SKIP_FIELDS, SKIP_OPS,
  PIPELINE_STATUSES, PIPELINE_SKILLS,
  type StepConfig, type CustomPipelineStep, type PipelineSectionProps,
} from './pipeline-section-constants';
export type { StepConfig, CustomPipelineStep } from './pipeline-section-constants';

export function PipelineSection({
  projectDocumentId,
  pipelineEnabled, setPipelineEnabled,
  pipelineSteps, setPipelineSteps,
  customPipelineSteps, setCustomPipelineSteps,
  useCustomPipeline, setUseCustomPipeline,
  antigravityConnected,
  testingUrls, setTestingUrls,
  testCredentials, setTestCredentials,
  heartbeatEnabled, setHeartbeatEnabled,
  heartbeatPaused, setHeartbeatPaused,
  heartbeatInterval, setHeartbeatInterval,
}: PipelineSectionProps) {
  const [expandedStepIndex, setExpandedStepIndex] = useState<number | null>(null);
  const updateStep = (key: string, patch: Partial<StepConfig>) => {
    const current = pipelineSteps[key] || { enabled: false, runner: 'desktop' };
    setPipelineSteps({ ...pipelineSteps, [key]: { ...current, ...patch } });
  };

  const hasAntigravityStep = Object.values(pipelineSteps).some(
    (s) => s.runner === 'antigravity',
  );

  return (
    <section className="space-y-6">
      <div className="flex justify-between items-end border-b border-outline-variant/10 pb-2">
        <h2 className="text-[10px] uppercase tracking-[0.2em] text-on-surface-variant font-bold">03. Pipeline Logic</h2>
        <span className="text-[9px] font-mono text-outline">PLC_SYS_03</span>
      </div>

      <div className="bg-surface-container-low border border-outline-variant/30 p-8 space-y-8">
      <p className="text-sm text-primary-fixed">
        Configure which agent runner handles each step. Manual pipeline buttons always use these settings.
        Enable auto-trigger per step to run automatically on status change.
      </p>

      <div className="space-y-3">
        {STEPS.map((step) => {
          const config = pipelineSteps[step.key] || { enabled: false, runner: 'desktop' };
          return (
            <div key={step.key} className="border border-outline-variant/20 p-3 space-y-2">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    {(() => {
                      const pokemon = getPokemonForStep(step.key);
                      return pokemon ? (
                        <img src={pokemon.sprite} alt={pokemon.name} className="h-8 w-8 object-contain image-rendering-pixelated" title={pokemon.name} />
                      ) : null;
                    })()}
                    <span className="text-sm font-medium text-on-surface">{step.label}</span>
                    <span className="rounded bg-surface-container-high px-1.5 py-0.5 text-[10px] font-mono text-primary-fixed">
                      {step.status}
                    </span>
                  </div>
                  <p className="text-[10px] text-outline">{step.desc}</p>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-3 pt-1">
                <div className="flex items-center gap-1.5">
                  <span className="text-xs text-primary-fixed">Runner:</span>
                  <select
                    value={config.runner}
                    onChange={(e) => updateStep(step.key, { runner: e.target.value as StepConfig['runner'] })}
                    className="bg-surface-container-high border-b border-outline rounded-none px-0 py-1 text-xs text-on-surface focus:border-b-primary focus:outline-none focus:ring-0 appearance-none"
                  >
                    {RUNNERS.map((r) => (
                      <option key={r.value} value={r.value}>{r.label}</option>
                    ))}
                  </select>
                </div>

                {config.runner === 'antigravity' && (
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs text-primary-fixed">Model:</span>
                    <select
                      value={config.model || ''}
                      onChange={(e) => updateStep(step.key, { model: e.target.value })}
                      className="bg-surface-container-high border-b border-outline rounded-none px-0 py-1 text-xs text-on-surface focus:border-b-primary focus:outline-none focus:ring-0 w-52 appearance-none"
                    >
                      {ANTIGRAVITY_MODELS.map((m) => (
                        <option key={m.value} value={m.value}>{m.label}</option>
                      ))}
                    </select>
                  </div>
                )}

                <label className="ml-auto flex items-center gap-3 cursor-pointer">
                  <span className="text-[10px] uppercase tracking-widest text-primary-fixed">Auto</span>
                  <span className="relative inline-flex items-center">
                    <input
                      type="checkbox"
                      checked={config.enabled && pipelineEnabled}
                      onChange={() => {
                        if (!pipelineEnabled) setPipelineEnabled(true);
                        updateStep(step.key, { enabled: !(config.enabled && pipelineEnabled) });
                      }}
                      className="peer sr-only"
                    />
                    <span className="block h-5 w-9 rounded-none bg-surface-container-highest border border-outline-variant/30 peer-checked:bg-primary-fixed transition-colors" />
                    <span className="absolute left-[3px] top-[3px] h-3.5 w-3.5 bg-outline peer-checked:bg-primary peer-checked:translate-x-[14px] transition-all" />
                  </span>
                </label>
              </div>
            </div>
          );
        })}
      </div>

      {/* Custom Pipeline Steps */}
      <div className="border border-outline-variant/20 p-3 space-y-3">
        <label className="flex items-center justify-between cursor-pointer">
          <div>
            <span className="text-sm font-medium text-on-surface">Custom Pipeline Flow</span>
            <p className="text-[10px] text-outline">
              Define a custom step sequence with per-issue skip conditions. Overrides the default step order above when enabled.
            </p>
          </div>
          <span className="relative inline-flex items-center">
            <input
              type="checkbox"
              checked={useCustomPipeline}
              onChange={() => setUseCustomPipeline(!useCustomPipeline)}
              className="peer sr-only"
            />
            <span className="block h-5 w-9 rounded-none bg-surface-container-highest border border-outline-variant/30 peer-checked:bg-primary-fixed transition-colors" />
            <span className="absolute left-[3px] top-[3px] h-3.5 w-3.5 bg-outline peer-checked:bg-primary peer-checked:translate-x-[14px] transition-all" />
          </span>
        </label>

        {useCustomPipeline && (
          <div className="space-y-2 pt-2">
            {customPipelineSteps.map((step, i) => (
              <div key={i} className="border border-outline-variant/15 p-2.5 space-y-2">
                <div className="flex items-center gap-2">
                  <span className="text-[10px] text-outline font-mono w-4 shrink-0">{i + 1}</span>
                  <select
                    value={step.status}
                    onChange={(e) => {
                      const next = [...customPipelineSteps];
                      next[i] = { ...next[i], status: e.target.value };
                      setCustomPipelineSteps(next);
                    }}
                    className="bg-surface-container-high border-b border-outline rounded-none px-0 py-1 text-xs text-on-surface focus:border-b-primary focus:outline-none focus:ring-0 appearance-none flex-1"
                  >
                    <option value="">Status...</option>
                    {PIPELINE_STATUSES.map((s) => (
                      <option key={s} value={s}>{s}</option>
                    ))}
                  </select>
                  <span className="text-[10px] text-outline">→</span>
                  <select
                    value={step.skill}
                    onChange={(e) => {
                      const next = [...customPipelineSteps];
                      next[i] = { ...next[i], skill: e.target.value };
                      setCustomPipelineSteps(next);
                    }}
                    className="bg-surface-container-high border-b border-outline rounded-none px-0 py-1 text-xs text-on-surface focus:border-b-primary focus:outline-none focus:ring-0 appearance-none flex-1"
                  >
                    <option value="">Skill...</option>
                    {PIPELINE_SKILLS.map((s) => (
                      <option key={s} value={s}>{s}</option>
                    ))}
                  </select>
                  <select
                    value={step.runner}
                    onChange={(e) => {
                      const next = [...customPipelineSteps];
                      next[i] = { ...next[i], runner: e.target.value as 'desktop' | 'antigravity' };
                      setCustomPipelineSteps(next);
                    }}
                    className="bg-surface-container-high border-b border-outline rounded-none px-0 py-1 text-[10px] text-on-surface focus:border-b-primary focus:outline-none focus:ring-0 appearance-none w-24"
                  >
                    {RUNNERS.map((r) => (
                      <option key={r.value} value={r.value}>{r.label}</option>
                    ))}
                  </select>
                  {step.runner === 'antigravity' && (
                    <select
                      value={step.model || ''}
                      onChange={(e) => {
                        const next = [...customPipelineSteps];
                        next[i] = { ...next[i], model: e.target.value || undefined };
                        setCustomPipelineSteps(next);
                      }}
                      className="bg-surface-container-high border-b border-outline rounded-none px-0 py-1 text-[10px] text-on-surface focus:border-b-primary focus:outline-none focus:ring-0 appearance-none w-36"
                    >
                      {ANTIGRAVITY_MODELS.map((m) => (
                        <option key={m.value} value={m.value}>{m.label}</option>
                      ))}
                    </select>
                  )}
                  <button
                    type="button"
                    onClick={() => setExpandedStepIndex(expandedStepIndex === i ? null : i)}
                    className="rounded p-1 text-outline hover:text-on-surface"
                    title="Skip condition"
                  >
                    {expandedStepIndex === i ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                  </button>
                  <button
                    type="button"
                    onClick={() => setCustomPipelineSteps(customPipelineSteps.filter((_, j) => j !== i))}
                    className="rounded p-1 text-outline hover:bg-danger-surface hover:text-danger"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>

                {/* Expanded: skip condition */}
                {expandedStepIndex === i && (
                  <div className="pl-6 pt-1 space-y-2 border-t border-outline-variant/10">
                    <p className="text-[10px] text-outline">Skip condition — when matched, auto-advance to next status instead of running the skill</p>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-[10px] text-primary-fixed">If</span>
                      <select
                        value={step.skip?.field || ''}
                        onChange={(e) => {
                          const next = [...customPipelineSteps];
                          const field = e.target.value;
                          next[i] = {
                            ...next[i],
                            skip: field ? { field, op: step.skip?.op || 'eq', value: step.skip?.value || '' } : undefined,
                          };
                          setCustomPipelineSteps(next);
                        }}
                        className="bg-surface-container-high border-b border-outline rounded-none px-0 py-1 text-xs text-on-surface focus:border-b-primary focus:outline-none focus:ring-0 appearance-none w-24"
                      >
                        <option value="">None</option>
                        {SKIP_FIELDS.map((f) => (
                          <option key={f} value={f}>{f}</option>
                        ))}
                      </select>
                      {step.skip?.field && (
                        <>
                          <select
                            value={step.skip.op}
                            onChange={(e) => {
                              const next = [...customPipelineSteps];
                              next[i] = { ...next[i], skip: { ...step.skip!, op: e.target.value as any } };
                              setCustomPipelineSteps(next);
                            }}
                            className="bg-surface-container-high border-b border-outline rounded-none px-0 py-1 text-xs text-on-surface focus:border-b-primary focus:outline-none focus:ring-0 appearance-none w-16"
                          >
                            {SKIP_OPS.map((o) => (
                              <option key={o.value} value={o.value}>{o.label}</option>
                            ))}
                          </select>
                          <input
                            type="text"
                            value={Array.isArray(step.skip.value) ? step.skip.value.join(', ') : step.skip.value}
                            onChange={(e) => {
                              const next = [...customPipelineSteps];
                              const raw = e.target.value;
                              const isArray = step.skip!.op === 'in' || step.skip!.op === 'notIn';
                              next[i] = {
                                ...next[i],
                                skip: {
                                  ...step.skip!,
                                  value: isArray ? raw.split(',').map((v) => v.trim()).filter(Boolean) : raw,
                                },
                              };
                              setCustomPipelineSteps(next);
                            }}
                            placeholder={step.skip.op === 'in' || step.skip.op === 'notIn' ? 'val1, val2' : 'value'}
                            className="bg-transparent border-0 border-b border-outline/30 rounded-none py-1 text-xs text-on-surface font-mono placeholder:text-outline/40 focus:outline-none focus:border-b-primary focus:ring-0 transition-colors w-32"
                          />
                          <span className="text-[10px] text-primary-fixed">→</span>
                          <select
                            value={step.nextStatus || ''}
                            onChange={(e) => {
                              const next = [...customPipelineSteps];
                              next[i] = { ...next[i], nextStatus: e.target.value || undefined };
                              setCustomPipelineSteps(next);
                            }}
                            className="bg-surface-container-high border-b border-outline rounded-none px-0 py-1 text-xs text-on-surface focus:border-b-primary focus:outline-none focus:ring-0 appearance-none w-24"
                          >
                            <option value="">No advance</option>
                            {PIPELINE_STATUSES.map((s) => (
                              <option key={s} value={s}>{s}</option>
                            ))}
                          </select>
                        </>
                      )}
                    </div>
                  </div>
                )}
              </div>
            ))}
            <button
              type="button"
              onClick={() => setCustomPipelineSteps([...customPipelineSteps, { status: '', skill: '', runner: 'desktop' }])}
              className="flex items-center gap-1 text-xs text-primary-fixed hover:text-on-surface-variant"
            >
              <Plus className="h-3.5 w-3.5" />
              Add step
            </button>
          </div>
        )}
      </div>

      <div className="border border-outline-variant/20 p-3 space-y-3">
        <div>
          <span className="text-sm font-medium text-on-surface">Testing URLs</span>
          <p className="text-[10px] text-outline">
            URLs used by QA agents and testers to test deployed changes.
          </p>
        </div>
        <div className="space-y-2">
          {testingUrls.map((entry, i) => (
            <div key={i} className="flex items-center gap-2">
              <input
                type="text"
                value={entry.label}
                onChange={(e) => {
                  const next = [...testingUrls];
                  next[i] = { ...next[i], label: e.target.value };
                  setTestingUrls(next);
                }}
                placeholder="e.g. Frontend"
                className="bg-transparent border-0 border-b border-outline/30 rounded-none py-3 text-sm text-on-surface placeholder:text-outline/40 focus:outline-none focus:border-b-primary focus:ring-0 transition-colors w-28"
              />
              <input
                type="text"
                value={entry.url}
                onChange={(e) => {
                  const next = [...testingUrls];
                  next[i] = { ...next[i], url: e.target.value };
                  setTestingUrls(next);
                }}
                placeholder="https://..."
                className="bg-transparent border-0 border-b border-outline/30 rounded-none py-3 text-sm text-on-surface font-mono placeholder:text-outline/40 focus:outline-none focus:border-b-primary focus:ring-0 transition-colors flex-1"
              />
              <button
                type="button"
                onClick={() => setTestingUrls(testingUrls.filter((_, j) => j !== i))}
                className="rounded p-1 text-outline hover:bg-danger-surface hover:text-danger"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
          <button
            type="button"
            onClick={() => setTestingUrls([...testingUrls, { label: '', url: '' }])}
            className="flex items-center gap-1 text-xs text-primary-fixed hover:text-on-surface-variant"
          >
            <Plus className="h-3.5 w-3.5" />
            Add URL
          </button>
        </div>
      </div>

      <div className="border border-outline-variant/20 p-3 space-y-3">
        <div>
          <span className="text-sm font-medium text-on-surface">Test Credentials</span>
          <p className="text-[10px] text-outline">
            Accounts available for QA testing. Shown on issues when status is &quot;testing&quot;.
          </p>
        </div>
        <div className="space-y-2">
          {testCredentials.map((cred, i) => (
            <div key={i} className="flex items-center gap-2">
              <input
                type="text"
                value={cred.label}
                onChange={(e) => {
                  const next = [...testCredentials];
                  next[i] = { ...next[i], label: e.target.value };
                  setTestCredentials(next);
                }}
                placeholder="Role (e.g. Admin)"
                className="bg-transparent border-0 border-b border-outline/30 rounded-none py-3 text-sm text-on-surface placeholder:text-outline/40 focus:outline-none focus:border-b-primary focus:ring-0 transition-colors w-24"
              />
              <input
                type="text"
                value={cred.username}
                onChange={(e) => {
                  const next = [...testCredentials];
                  next[i] = { ...next[i], username: e.target.value };
                  setTestCredentials(next);
                }}
                placeholder="Username / email"
                className="bg-transparent border-0 border-b border-outline/30 rounded-none py-3 text-sm text-on-surface font-mono placeholder:text-outline/40 focus:outline-none focus:border-b-primary focus:ring-0 transition-colors flex-1"
              />
              <input
                type="text"
                value={cred.password}
                onChange={(e) => {
                  const next = [...testCredentials];
                  next[i] = { ...next[i], password: e.target.value };
                  setTestCredentials(next);
                }}
                placeholder="Password"
                className="bg-transparent border-0 border-b border-outline/30 rounded-none py-3 text-sm text-on-surface font-mono placeholder:text-outline/40 focus:outline-none focus:border-b-primary focus:ring-0 transition-colors w-32"
              />
              <button
                type="button"
                onClick={() => setTestCredentials(testCredentials.filter((_, j) => j !== i))}
                className="rounded p-1 text-outline hover:bg-danger-surface hover:text-danger"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
          <button
            type="button"
            onClick={() => setTestCredentials([...testCredentials, { label: '', username: '', password: '' }])}
            className="flex items-center gap-1 text-xs text-primary-fixed hover:text-on-surface-variant"
          >
            <Plus className="h-3.5 w-3.5" />
            Add test account
          </button>
        </div>
      </div>

      {hasAntigravityStep && !antigravityConnected && (
        <div className="border border-warning/30 bg-warning-dim/10 p-3">
          <p className="text-xs text-warning">
            Antigravity runner selected but no project connected. Go to <strong>Integrations → Antigravity</strong> to create or connect a project.
          </p>
        </div>
      )}

      <p className="text-[10px] text-outline pt-1">
        Waiting, Tested, and Staging are always human gates — no auto toggle.
      </p>
      </div>

      {/* Heartbeat Section */}
      <div className="bg-surface-container-low border border-outline-variant/30 p-8 space-y-6">
        <div className="flex justify-between items-end border-b border-outline-variant/10 pb-2">
          <h3 className="text-[10px] uppercase tracking-[0.2em] text-on-surface-variant font-bold">Heartbeat</h3>
          <span className="text-[9px] font-mono text-outline">HBT_SYS</span>
        </div>

        <p className="text-sm text-primary-fixed">
          Periodic sweep that rescues stalled issues. Scans for pipeline-eligible issues with no active session and re-queues them.
          Requires pipeline to be enabled.
        </p>

        <div className="border border-outline-variant/20 p-3 space-y-3">
          <label className="flex items-center justify-between cursor-pointer">
            <div>
              <span className="text-sm font-medium text-on-surface">Enable Heartbeat</span>
              <p className="text-[10px] text-outline">
                Scans every tick for issues stuck at pipeline-eligible statuses with no queued or running session.
              </p>
            </div>
            <span className="relative inline-flex items-center">
              <input
                type="checkbox"
                checked={heartbeatEnabled}
                onChange={() => setHeartbeatEnabled(!heartbeatEnabled)}
                className="peer sr-only"
              />
              <span className="block h-5 w-9 rounded-none bg-surface-container-highest border border-outline-variant/30 peer-checked:bg-primary-fixed transition-colors" />
              <span className="absolute left-[3px] top-[3px] h-3.5 w-3.5 bg-outline peer-checked:bg-primary peer-checked:translate-x-[14px] transition-all" />
            </span>
          </label>

          {heartbeatEnabled && (
            <div className="space-y-3 pt-2">
              <label className="flex items-center justify-between cursor-pointer">
                <div>
                  <span className="text-sm font-medium text-on-surface">Paused</span>
                  <p className="text-[10px] text-outline">
                    Temporarily pause heartbeat without disabling it.
                  </p>
                </div>
                <span className="relative inline-flex items-center">
                  <input
                    type="checkbox"
                    checked={heartbeatPaused}
                    onChange={() => setHeartbeatPaused(!heartbeatPaused)}
                    className="peer sr-only"
                  />
                  <span className="block h-5 w-9 rounded-none bg-surface-container-highest border border-outline-variant/30 peer-checked:bg-primary-fixed transition-colors" />
                  <span className="absolute left-[3px] top-[3px] h-3.5 w-3.5 bg-outline peer-checked:bg-primary peer-checked:translate-x-[14px] transition-all" />
                </span>
              </label>

              <div>
                <label className="text-[10px] text-outline">Scan Interval (seconds)</label>
                <div className="flex items-center gap-3">
                  <input
                    type="number"
                    min={30}
                    max={600}
                    value={heartbeatInterval}
                    onChange={(e) => setHeartbeatInterval(Math.max(30, Math.min(600, Number(e.target.value) || 60)))}
                    className="bg-transparent border-0 border-b border-outline/30 rounded-none py-3 text-sm text-on-surface font-mono placeholder:text-outline/40 focus:outline-none focus:border-b-primary focus:ring-0 transition-colors w-24"
                  />
                  <span className="text-[10px] text-outline">min 30s, max 600s</span>
                </div>
              </div>
            </div>
          )}
        </div>

        {heartbeatEnabled && !pipelineEnabled && (
          <div className="border border-warning/30 bg-warning-dim/10 p-3">
            <p className="text-xs text-warning">
              Heartbeat requires the pipeline to be enabled. Enable pipeline steps above for heartbeat to have any effect.
            </p>
          </div>
        )}
      </div>
    </section>
  );
}
