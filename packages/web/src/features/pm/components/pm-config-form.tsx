'use client';

import { useEffect, useState } from 'react';
import { usePmConfig, useUpdatePmConfig } from '../hooks/use-pm-config';
import type { PmConfig, PmEventTriggers } from '../types';

const CRON_PRESETS = [
  { label: 'Off', value: null },
  { label: 'Every 15 min', value: '*/15 * * * *' },
  { label: 'Hourly', value: '0 * * * *' },
  { label: 'Every 6h', value: '0 */6 * * *' },
];

const MODEL_OPTIONS = [
  { label: 'Default (app config)', value: '' },
  { label: 'Opus', value: 'opus' },
  { label: 'Sonnet', value: 'sonnet' },
  { label: 'Haiku', value: 'haiku' },
];

const TRIGGER_LABELS: Record<keyof PmEventTriggers, string> = {
  jobFailed: 'Job failed',
  pipelineStalled: 'Pipeline stalled',
  needsInfo: 'Issue needs info',
  queuePressure: 'Queue pressure',
  graphChanged: 'Knowledge graph changed',
};

function isDirty(a: PmConfig, b: PmConfig): boolean {
  return (
    a.enabled !== b.enabled ||
    a.cadenceCron !== b.cadenceCron ||
    a.customInstructions !== b.customInstructions ||
    a.modelOverride !== b.modelOverride ||
    a.maxRunsPerHour !== b.maxRunsPerHour ||
    JSON.stringify(a.eventTriggers) !== JSON.stringify(b.eventTriggers)
  );
}

export function PmConfigForm({ projectId }: { projectId: string }) {
  const { data, isLoading } = usePmConfig(projectId);
  const update = useUpdatePmConfig(projectId);
  const [draft, setDraft] = useState<PmConfig | null>(null);

  useEffect(() => {
    if (data) setDraft(data);
  }, [data]);

  if (isLoading || !draft || !data) {
    return <p className="text-sm text-outline">Loading PM Agent config…</p>;
  }

  const dirty = isDirty(draft, data);

  function patch<K extends keyof PmConfig>(key: K, value: PmConfig[K]) {
    setDraft((d) => (d ? { ...d, [key]: value } : d));
  }

  function patchTrigger(key: keyof PmEventTriggers, value: boolean) {
    setDraft((d) =>
      d ? { ...d, eventTriggers: { ...d.eventTriggers, [key]: value } } : d,
    );
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!draft) return;
    update.mutate({
      enabled: draft.enabled,
      cadenceCron: draft.cadenceCron,
      eventTriggers: draft.eventTriggers,
      customInstructions: draft.customInstructions,
      modelOverride: draft.modelOverride,
      maxRunsPerHour: draft.maxRunsPerHour,
    });
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="space-y-5 rounded-lg border border-outline-variant/30 bg-surface-container-low p-5"
    >
      <header className="flex items-center justify-between">
        <h2 className="text-base font-semibold text-on-surface">
          PM Agent Configuration
        </h2>
        <label className="flex items-center gap-2 text-sm text-on-surface-variant">
          <input
            type="checkbox"
            checked={draft.enabled}
            onChange={(e) => patch('enabled', e.target.checked)}
          />
          Enabled
        </label>
      </header>

      <fieldset>
        <legend className="text-xs font-semibold uppercase tracking-wider text-on-surface-variant">
          Cadence
        </legend>
        <div className="mt-2 flex flex-wrap gap-2">
          {CRON_PRESETS.map((p) => {
            const active = draft.cadenceCron === p.value;
            return (
              <button
                key={p.label}
                type="button"
                onClick={() => patch('cadenceCron', p.value)}
                className={`rounded border px-3 py-1 text-xs ${
                  active
                    ? 'border-primary bg-primary text-on-primary'
                    : 'border-outline-variant text-on-surface-variant hover:bg-surface-container-high'
                }`}
              >
                {p.label}
              </button>
            );
          })}
        </div>
        <input
          type="text"
          value={draft.cadenceCron ?? ''}
          onChange={(e) => patch('cadenceCron', e.target.value || null)}
          placeholder="custom cron (e.g. */30 * * * *)"
          className="mt-2 w-full rounded border border-outline-variant bg-surface px-3 py-1.5 text-sm text-on-surface"
        />
      </fieldset>

      <fieldset>
        <legend className="text-xs font-semibold uppercase tracking-wider text-on-surface-variant">
          Event triggers
        </legend>
        <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
          {(Object.keys(TRIGGER_LABELS) as Array<keyof PmEventTriggers>).map(
            (key) => (
              <label
                key={key}
                className="flex items-center gap-2 text-sm text-on-surface-variant"
              >
                <input
                  type="checkbox"
                  checked={draft.eventTriggers[key]}
                  onChange={(e) => patchTrigger(key, e.target.checked)}
                />
                {TRIGGER_LABELS[key]}
              </label>
            ),
          )}
        </div>
      </fieldset>

      <div>
        <label className="text-xs font-semibold uppercase tracking-wider text-on-surface-variant">
          Custom instructions
        </label>
        <textarea
          rows={6}
          value={draft.customInstructions ?? ''}
          onChange={(e) => patch('customInstructions', e.target.value || null)}
          placeholder="Optional Markdown — additional system prompt for the PM agent"
          className="mt-1 w-full rounded border border-outline-variant bg-surface px-3 py-2 text-sm text-on-surface"
        />
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <label className="text-xs font-semibold uppercase tracking-wider text-on-surface-variant">
            Model override
          </label>
          <select
            value={draft.modelOverride ?? ''}
            onChange={(e) => patch('modelOverride', e.target.value || null)}
            className="mt-1 w-full rounded border border-outline-variant bg-surface px-3 py-1.5 text-sm text-on-surface"
          >
            {MODEL_OPTIONS.map((o) => (
              <option key={o.label} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="text-xs font-semibold uppercase tracking-wider text-on-surface-variant">
            Max runs/hour
          </label>
          <input
            type="number"
            min={1}
            max={60}
            value={draft.maxRunsPerHour}
            onChange={(e) =>
              patch(
                'maxRunsPerHour',
                Math.max(1, Math.min(60, Number(e.target.value) || 1)),
              )
            }
            className="mt-1 w-full rounded border border-outline-variant bg-surface px-3 py-1.5 text-sm text-on-surface"
          />
        </div>
      </div>

      <div className="flex items-center justify-end gap-3">
        {update.isError && (
          <span className="text-xs text-error">
            Failed to save: {update.error?.message}
          </span>
        )}
        {update.isSuccess && !dirty && (
          <span className="text-xs text-success">Saved.</span>
        )}
        <button
          type="submit"
          disabled={!dirty || update.isPending}
          className="rounded bg-primary px-4 py-1.5 text-sm font-semibold text-on-primary disabled:opacity-50"
        >
          {update.isPending ? 'Saving…' : 'Save'}
        </button>
      </div>
    </form>
  );
}
