'use client';

import { useState } from 'react';
import type { Schedule, ScheduleFormData, ScheduleRunner } from '../api';

interface ScheduleFormProps {
  initial?: Schedule | null;
  projectDocumentId: string;
  onSubmit: (data: ScheduleFormData) => void;
  onCancel: () => void;
  loading?: boolean;
}

const CRON_PRESETS = [
  { label: 'Every hour', value: '0 * * * *' },
  { label: 'Every 2 hours', value: '0 */2 * * *' },
  { label: 'Every 6 hours', value: '0 */6 * * *' },
  { label: 'Daily at midnight', value: '0 0 * * *' },
  { label: 'Daily at 9 AM', value: '0 9 * * *' },
  { label: 'Weekly (Monday 9 AM)', value: '0 9 * * 1' },
];

export function ScheduleForm({ initial, projectDocumentId, onSubmit, onCancel, loading }: ScheduleFormProps) {
  const [name, setName] = useState(initial?.name || '');
  const [cron, setCron] = useState(initial?.cron || '0 */2 * * *');
  const [prompt, setPrompt] = useState(initial?.prompt || '');
  const [runner, setRunner] = useState<ScheduleRunner>(initial?.runner || 'antigravity');
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  const [targetProjectSlug, setTargetProjectSlug] = useState(initial?.targetProjectSlug || '');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSubmit({
      name,
      cron,
      prompt,
      runner,
      enabled,
      targetProjectSlug: targetProjectSlug || undefined,
      project: initial ? undefined : projectDocumentId,
    });
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <label className="block text-xs font-semibold text-on-surface-variant mb-1">Name</label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          placeholder="e.g. Nightly Health Check"
          className="w-full rounded-sm border border-outline-variant/30 bg-surface-container-low px-3 py-2 text-sm text-on-surface placeholder:text-outline focus:border-primary focus:outline-none"
        />
      </div>

      <div>
        <label className="block text-xs font-semibold text-on-surface-variant mb-1">Cron Expression</label>
        <input
          type="text"
          value={cron}
          onChange={(e) => setCron(e.target.value)}
          required
          placeholder="0 */2 * * *"
          className="w-full rounded-sm border border-outline-variant/30 bg-surface-container-low px-3 py-2 text-sm font-mono text-on-surface placeholder:text-outline focus:border-primary focus:outline-none"
        />
        <div className="flex flex-wrap gap-1.5 mt-2">
          {CRON_PRESETS.map((p) => (
            <button
              key={p.value}
              type="button"
              onClick={() => setCron(p.value)}
              className={`px-2 py-0.5 text-[10px] rounded-sm border transition-colors ${
                cron === p.value
                  ? 'border-primary bg-primary/10 text-primary'
                  : 'border-outline-variant/30 text-on-surface-variant hover:border-primary/50'
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      <div>
        <label className="block text-xs font-semibold text-on-surface-variant mb-1">Prompt</label>
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          required
          rows={4}
          placeholder="The instruction to execute on schedule..."
          className="w-full rounded-sm border border-outline-variant/30 bg-surface-container-low px-3 py-2 text-sm text-on-surface placeholder:text-outline focus:border-primary focus:outline-none resize-y"
        />
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-xs font-semibold text-on-surface-variant mb-1">Runner</label>
          <select
            value={runner}
            onChange={(e) => setRunner(e.target.value as ScheduleRunner)}
            className="w-full rounded-sm border border-outline-variant/30 bg-surface-container-low px-3 py-2 text-sm text-on-surface focus:border-primary focus:outline-none"
          >
            <option value="antigravity">Antigravity</option>
            <option value="desktop">Desktop</option>
          </select>
        </div>

        <div>
          <label className="block text-xs font-semibold text-on-surface-variant mb-1">Target Project (optional)</label>
          <input
            type="text"
            value={targetProjectSlug}
            onChange={(e) => setTargetProjectSlug(e.target.value)}
            placeholder="project-slug"
            className="w-full rounded-sm border border-outline-variant/30 bg-surface-container-low px-3 py-2 text-sm text-on-surface placeholder:text-outline focus:border-primary focus:outline-none"
          />
        </div>
      </div>

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => setEnabled(!enabled)}
          className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
            enabled ? 'bg-primary' : 'bg-outline-variant/40'
          }`}
        >
          <span
            className={`inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform ${
              enabled ? 'translate-x-4.5' : 'translate-x-0.5'
            }`}
          />
        </button>
        <span className="text-xs text-on-surface-variant">{enabled ? 'Enabled' : 'Disabled'}</span>
      </div>

      <div className="flex justify-end gap-2 pt-2">
        <button
          type="button"
          onClick={onCancel}
          className="px-4 py-2 text-xs font-semibold text-on-surface-variant hover:text-on-surface transition-colors"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={loading || !name || !cron || !prompt}
          className="px-4 py-2 text-xs font-semibold rounded-sm bg-primary text-on-primary hover:bg-tertiary transition-colors disabled:opacity-50"
        >
          {initial ? 'Update' : 'Create'} Schedule
        </button>
      </div>
    </form>
  );
}
