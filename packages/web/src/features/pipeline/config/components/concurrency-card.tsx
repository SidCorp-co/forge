'use client';

import { Input } from '@/components/ui';

interface Props {
  /** null = no override stored; placeholder shows the inherited default. */
  value: number | null;
  /** Inherited default surfaced as placeholder text when value is null. */
  defaultValue: number;
  /** Passing null clears the override. */
  onChange: (n: number | null) => void;
}

const MIN = 1;
const MAX = 50;

export function ConcurrencyCard({ value, defaultValue, onChange }: Props) {
  return (
    <div className="bg-surface-container-low border border-outline-variant/30 p-6 space-y-5">
      <div className="space-y-1">
        <h3 className="text-sm font-semibold text-on-surface">Project concurrency</h3>
        <p className="text-xs text-on-surface-variant">
          Max issues this project can run in parallel. Lower this to serialise work onto a single
          runner.
        </p>
      </div>

      <label className="space-y-1 block max-w-xs">
        <span className="text-xs font-medium text-on-surface block">Max concurrent issues</span>
        <Input
          type="number"
          min={MIN}
          max={MAX}
          value={value ?? ''}
          placeholder={String(defaultValue)}
          onChange={(e) => {
            const raw = e.target.value;
            if (raw === '') return;
            const n = Number(raw);
            if (!Number.isFinite(n)) return;
            const clamped = Math.max(MIN, Math.min(MAX, Math.trunc(n)));
            onChange(clamped);
          }}
          className="h-9"
        />
        {value === null ? (
          <span className="text-[10px] text-on-surface-variant block">
            Using default: {defaultValue}
          </span>
        ) : (
          <button
            type="button"
            onClick={() => onChange(null)}
            className="text-[10px] font-medium uppercase tracking-[0.15em] text-on-surface-variant hover:text-on-surface"
          >
            Reset to default
          </button>
        )}
      </label>
    </div>
  );
}
